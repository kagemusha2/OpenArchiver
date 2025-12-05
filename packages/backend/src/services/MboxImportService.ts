import { StorageService } from './StorageService';
import { IngestionService } from './IngestionService';
import { config } from '../config/index';
import { logger } from '../config/logger';
import type { MboxPostProcessAction } from '../config/mboxImport';
import type { StorageObject } from '@open-archiver/types';
import { simpleParser, ParsedMail, Attachment, AddressObject } from 'mailparser';
import { Transform } from 'stream';
import { createHash, randomUUID } from 'crypto';
import { db } from '../database';
import {
	archivedEmails,
	attachments as attachmentsSchema,
	emailAttachments,
	ingestionSources,
} from '../database/schema';
import { eq, and } from 'drizzle-orm';
import type { EmailAddress, EmailObject } from '@open-archiver/types';
import { getThreadId } from './ingestion-connectors/helpers/utils';
import { indexingQueue } from '../jobs/queues';
import path from 'path';

/**
 * Result of processing a single MBOX file.
 */
export interface MboxFileResult {
	filePath: string;
	status: 'success' | 'partial' | 'error';
	emailsProcessed: number;
	emailsFailed: number;
	error?: string;
}

/**
 * Result of the entire MBOX import operation.
 */
export interface MboxImportResult {
	filesFound: number;
	filesProcessed: number;
	filesFailed: number;
	totalEmailsProcessed: number;
	totalEmailsFailed: number;
	results: MboxFileResult[];
}

/**
 * A Transform stream that splits an MBOX file into individual email messages.
 */
class MboxSplitter extends Transform {
	private buffer: Buffer = Buffer.alloc(0);
	private delimiter: Buffer = Buffer.from('\nFrom ');
	private firstChunk: boolean = true;

	_transform(chunk: Buffer, encoding: string, callback: Function) {
		if (this.firstChunk) {
			// Check if the file starts with "From ". If not, prepend it to the first email.
			if (chunk.subarray(0, 5).toString() !== 'From ') {
				this.push(Buffer.from('From '));
			}
			this.firstChunk = false;
		}

		let currentBuffer = Buffer.concat([this.buffer, chunk]);
		let position;

		while ((position = currentBuffer.indexOf(this.delimiter)) > -1) {
			const email = currentBuffer.subarray(0, position);
			if (email.length > 0) {
				this.push(email);
			}
			// The next email starts with "From ", which is what the parser expects.
			currentBuffer = currentBuffer.subarray(position + 1);
		}

		this.buffer = currentBuffer;
		callback();
	}

	_flush(callback: Function) {
		if (this.buffer.length > 0) {
			this.push(this.buffer);
		}
		callback();
	}
}

/**
 * Service for importing MBOX files from the configured uploads folder.
 */
export class MboxImportService {
	private storage: StorageService;
	private uploadsPrefix: string;
	private postProcessAction: MboxPostProcessAction;
	private processedPrefix: string;

	constructor() {
		this.storage = new StorageService();
		this.uploadsPrefix = config.mboxImport.uploadsPrefix;
		this.postProcessAction = config.mboxImport.postProcessAction;
		this.processedPrefix = config.mboxImport.processedPrefix;
	}

	/**
	 * Import all MBOX files from the configured uploads folder.
	 * This creates an ingestion source for each file and processes the emails.
	 */
	public async importMboxFiles(): Promise<MboxImportResult> {
		const result: MboxImportResult = {
			filesFound: 0,
			filesProcessed: 0,
			filesFailed: 0,
			totalEmailsProcessed: 0,
			totalEmailsFailed: 0,
			results: [],
		};

		try {
			// List all .mbox files in the uploads prefix
			const mboxFiles = await this.storage.list(this.uploadsPrefix, '.mbox');
			result.filesFound = mboxFiles.length;

			logger.info(
				{ uploadsPrefix: this.uploadsPrefix, filesFound: mboxFiles.length },
				'Found MBOX files for import'
			);

			if (mboxFiles.length === 0) {
				return result;
			}

			// Process each MBOX file
			for (const file of mboxFiles) {
				const fileResult = await this.processFile(file);
				result.results.push(fileResult);

				if (fileResult.status === 'error') {
					result.filesFailed++;
				} else {
					result.filesProcessed++;
				}

				result.totalEmailsProcessed += fileResult.emailsProcessed;
				result.totalEmailsFailed += fileResult.emailsFailed;
			}

			logger.info(
				{
					filesProcessed: result.filesProcessed,
					filesFailed: result.filesFailed,
					totalEmailsProcessed: result.totalEmailsProcessed,
				},
				'MBOX import completed'
			);

			return result;
		} catch (error) {
			logger.error({ error }, 'Failed to import MBOX files');
			throw error;
		}
	}

	/**
	 * Process a single MBOX file.
	 */
	private async processFile(file: StorageObject): Promise<MboxFileResult> {
		const fileName = path.basename(file.key);
		const fileResult: MboxFileResult = {
			filePath: file.key,
			status: 'success',
			emailsProcessed: 0,
			emailsFailed: 0,
		};

		try {
			logger.info({ filePath: file.key }, 'Processing MBOX file');

			// Create an ingestion source for this import
			const ingestionSource = await this.createIngestionSource(fileName, file.key);

			// Process the MBOX file
			const fileStream = await this.storage.getStream(file.key);
			const mboxSplitter = new MboxSplitter();
			const emailStream = fileStream.pipe(mboxSplitter);

			for await (const emailBuffer of emailStream) {
				try {
					const emailObject = await this.parseMessage(emailBuffer as Buffer);
					const pendingEmail = await this.processEmail(emailObject, ingestionSource);
					if (pendingEmail) {
						fileResult.emailsProcessed++;
					}
				} catch (error) {
					logger.error(
						{ error, filePath: file.key },
						'Failed to process a single message from MBOX file'
					);
					fileResult.emailsFailed++;
				}
			}

			// Update ingestion source status
			await db
				.update(ingestionSources)
				.set({
					status: 'imported',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage: `Imported ${fileResult.emailsProcessed} emails, ${fileResult.emailsFailed} failed`,
				})
				.where(eq(ingestionSources.id, ingestionSource.id));

			// Post-process the file (move, delete, or keep)
			await this.postProcessFile(file.key);

			if (fileResult.emailsFailed > 0 && fileResult.emailsProcessed > 0) {
				fileResult.status = 'partial';
			}

			logger.info(
				{
					filePath: file.key,
					emailsProcessed: fileResult.emailsProcessed,
					emailsFailed: fileResult.emailsFailed,
				},
				'MBOX file processed'
			);
		} catch (error) {
			logger.error({ error, filePath: file.key }, 'Failed to process MBOX file');
			fileResult.status = 'error';
			fileResult.error = error instanceof Error ? error.message : 'Unknown error';
		}

		return fileResult;
	}

	/**
	 * Create an ingestion source for the MBOX import.
	 */
	private async createIngestionSource(fileName: string, filePath: string) {
		const sourceName = `MBOX Import - ${fileName}`;

		const [newSource] = await db
			.insert(ingestionSources)
			.values({
				name: sourceName,
				provider: 'mbox_import',
				status: 'importing',
				credentials: JSON.stringify({
					type: 'mbox_import',
					uploadedFileName: fileName,
					uploadedFilePath: filePath,
				}),
				userId: 'system', // System-initiated import
				lastSyncStartedAt: new Date(),
			})
			.returning();

		logger.info({ sourceId: newSource.id, sourceName }, 'Created ingestion source for MBOX import');

		return newSource;
	}

	/**
	 * Parse a single email message from MBOX buffer.
	 */
	private async parseMessage(emlBuffer: Buffer): Promise<EmailObject> {
		const parsedEmail: ParsedMail = await simpleParser(emlBuffer);

		const attachments = parsedEmail.attachments.map((attachment: Attachment) => ({
			filename: attachment.filename || 'untitled',
			contentType: attachment.contentType,
			size: attachment.size,
			content: attachment.content as Buffer,
		}));

		const mapAddresses = (
			addresses: AddressObject | AddressObject[] | undefined
		): EmailAddress[] => {
			if (!addresses) return [];
			const addressArray = Array.isArray(addresses) ? addresses : [addresses];
			return addressArray.flatMap((a) =>
				a.value.map((v) => ({
					name: v.name,
					address: v.address?.replaceAll(`'`, '') || '',
				}))
			);
		};

		const threadId = getThreadId(parsedEmail.headers);
		let messageId = parsedEmail.messageId;

		if (!messageId) {
			messageId = `generated-${createHash('sha256').update(emlBuffer).digest('hex')}`;
		}

		const from = mapAddresses(parsedEmail.from);
		if (from.length === 0) {
			from.push({ name: 'No Sender', address: 'No Sender' });
		}

		// Extract folder path from headers
		const gmailLabels = parsedEmail.headers.get('x-gmail-labels');
		const folderHeader = parsedEmail.headers.get('x-folder');
		let finalPath = '';

		if (gmailLabels && typeof gmailLabels === 'string') {
			finalPath = gmailLabels.split(',')[0];
		} else if (folderHeader && typeof folderHeader === 'string') {
			finalPath = folderHeader;
		}

		return {
			id: messageId,
			threadId: threadId,
			from,
			to: mapAddresses(parsedEmail.to),
			cc: mapAddresses(parsedEmail.cc),
			bcc: mapAddresses(parsedEmail.bcc),
			subject: parsedEmail.subject || '',
			body: parsedEmail.text || '',
			html: parsedEmail.html || '',
			headers: parsedEmail.headers,
			attachments,
			receivedAt: parsedEmail.date || new Date(),
			eml: emlBuffer,
			path: finalPath,
		};
	}

	/**
	 * Process and store a single email.
	 */
	private async processEmail(
		email: EmailObject,
		source: typeof ingestionSources.$inferSelect
	): Promise<{ archivedEmailId: string } | null> {
		try {
			// Generate a unique message ID for the email
			const messageIdHeader = email.headers.get('message-id');
			let messageId: string | undefined;
			if (Array.isArray(messageIdHeader)) {
				messageId = messageIdHeader[0];
			} else if (typeof messageIdHeader === 'string') {
				messageId = messageIdHeader;
			}
			if (!messageId) {
				messageId = `generated-${createHash('sha256')
					.update(email.eml ?? Buffer.from(email.body, 'utf-8'))
					.digest('hex')}-${source.id}-${email.id}`;
			}

			// Check if an email with the same message ID has already been imported
			const existingEmail = await db.query.archivedEmails.findFirst({
				where: and(
					eq(archivedEmails.messageIdHeader, messageId),
					eq(archivedEmails.ingestionSourceId, source.id)
				),
			});

			if (existingEmail) {
				logger.info(
					{ messageId, ingestionSourceId: source.id },
					'Skipping duplicate email'
				);
				return null;
			}

			const emlBuffer = email.eml ?? Buffer.from(email.body, 'utf-8');
			const emailHash = createHash('sha256').update(emlBuffer).digest('hex');
			const sanitizedPath = email.path ? email.path : '';
			const emailPath = `${config.storage.openArchiverFolderName}/${source.name.replaceAll(' ', '-')}-${source.id}/emails/${sanitizedPath}${email.id}.eml`;
			await this.storage.put(emailPath, emlBuffer);

			// Construct the userEmail from the filename
			const displayName = path.basename(source.name);
			const userEmail = `${displayName.replace(/ /g, '.').toLowerCase()}@mbox.local`;

			const [archivedEmail] = await db
				.insert(archivedEmails)
				.values({
					ingestionSourceId: source.id,
					userEmail,
					threadId: email.threadId,
					messageIdHeader: messageId,
					sentAt: email.receivedAt,
					subject: email.subject,
					senderName: email.from[0]?.name,
					senderEmail: email.from[0]?.address,
					recipients: {
						to: email.to,
						cc: email.cc,
						bcc: email.bcc,
					},
					storagePath: emailPath,
					storageHashSha256: emailHash,
					sizeBytes: emlBuffer.length,
					hasAttachments: email.attachments.length > 0,
					path: email.path,
					tags: [],
				})
				.returning();

			// Process attachments
			if (email.attachments.length > 0) {
				for (const attachment of email.attachments) {
					const attachmentBuffer = attachment.content;
					const attachmentHash = createHash('sha256')
						.update(attachmentBuffer)
						.digest('hex');

					// Check if an attachment with the same hash already exists for this source
					const existingAttachment = await db.query.attachments.findFirst({
						where: and(
							eq(attachmentsSchema.contentHashSha256, attachmentHash),
							eq(attachmentsSchema.ingestionSourceId, source.id)
						),
					});

					let attachmentRecord = existingAttachment;

					if (!attachmentRecord) {
						// Create a unique path and save the attachment
						const uniqueId = randomUUID().slice(0, 5);
						const storagePath = `${config.storage.openArchiverFolderName}/${source.name.replaceAll(' ', '-')}-${source.id}/attachments/${uniqueId}-${attachment.filename}`;
						await this.storage.put(storagePath, attachmentBuffer);

						// Insert a new attachment record
						[attachmentRecord] = await db
							.insert(attachmentsSchema)
							.values({
								filename: attachment.filename,
								mimeType: attachment.contentType,
								sizeBytes: attachment.size,
								contentHashSha256: attachmentHash,
								storagePath: storagePath,
								ingestionSourceId: source.id,
							})
							.returning();
					}

					// Link the attachment record to the email
					await db
						.insert(emailAttachments)
						.values({
							emailId: archivedEmail.id,
							attachmentId: attachmentRecord.id,
						})
						.onConflictDoNothing();
				}
			}

			// Add email to indexing queue
			await indexingQueue.add('index-email', { archivedEmailId: archivedEmail.id });

			return { archivedEmailId: archivedEmail.id };
		} catch (error) {
			logger.error({
				message: `Failed to process email ${email.id} for source ${source.id}`,
				error,
				emailId: email.id,
				ingestionSourceId: source.id,
			});
			return null;
		}
	}

	/**
	 * Post-process a file after successful import.
	 */
	private async postProcessFile(filePath: string): Promise<void> {
		try {
			switch (this.postProcessAction) {
				case 'move':
					const fileName = path.basename(filePath);
					const destinationPath = `${this.processedPrefix}${fileName}`;
					await this.storage.copy(filePath, destinationPath);
					await this.storage.delete(filePath);
					logger.info({ filePath, destinationPath }, 'Moved processed MBOX file');
					break;
				case 'delete':
					await this.storage.delete(filePath);
					logger.info({ filePath }, 'Deleted processed MBOX file');
					break;
				case 'keep':
					logger.info({ filePath }, 'Keeping MBOX file in original location');
					break;
			}
		} catch (error) {
			logger.error({ error, filePath, action: this.postProcessAction }, 'Failed to post-process MBOX file');
			// Don't throw - we still want to return success for the import
		}
	}
}
