import { IStorageProvider, S3StorageConfig, StorageObject } from '@open-archiver/types';
import {
	S3Client,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	NotFound,
	ListObjectsV2Command,
	DeleteObjectsCommand,
	CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';

export class S3StorageProvider implements IStorageProvider {
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(config: S3StorageConfig) {
		this.client = new S3Client({
			endpoint: config.endpoint,
			region: config.region,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
			forcePathStyle: config.forcePathStyle,
		});
		this.bucket = config.bucket;
	}

	async put(path: string, content: Buffer | NodeJS.ReadableStream): Promise<void> {
		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.bucket,
				Key: path,
				Body: content instanceof Readable ? content : Readable.from(content),
			},
		});

		await upload.done();
	}

	async get(path: string): Promise<NodeJS.ReadableStream> {
		const command = new GetObjectCommand({
			Bucket: this.bucket,
			Key: path,
		});

		try {
			const response = await this.client.send(command);
			if (response.Body instanceof Readable) {
				return response.Body;
			}
			throw new Error('Readable stream not found in S3 response');
		} catch (error) {
			if (error instanceof NotFound) {
				throw new Error('File not found');
			}
			throw error;
		}
	}

	async delete(path: string): Promise<void> {
		// List all objects with the given prefix
		const listCommand = new ListObjectsV2Command({
			Bucket: this.bucket,
			Prefix: path,
		});
		const listedObjects = await this.client.send(listCommand);

		if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
			return;
		}

		// Create a list of objects to delete
		const deleteParams = {
			Bucket: this.bucket,
			Delete: {
				Objects: listedObjects.Contents.map(({ Key }) => ({ Key })),
			},
		};

		// Delete the objects
		const deleteCommand = new DeleteObjectsCommand(deleteParams);
		await this.client.send(deleteCommand);
	}

	async exists(path: string): Promise<boolean> {
		const command = new HeadObjectCommand({
			Bucket: this.bucket,
			Key: path,
		});

		try {
			await this.client.send(command);
			return true;
		} catch (error) {
			if (error instanceof NotFound) {
				return false;
			}
			throw error;
		}
	}

	async list(prefix: string, suffix?: string): Promise<StorageObject[]> {
		const objects: StorageObject[] = [];
		let continuationToken: string | undefined;

		do {
			const command = new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: prefix,
				ContinuationToken: continuationToken,
			});

			const response = await this.client.send(command);

			if (response.Contents) {
				for (const item of response.Contents) {
					if (item.Key) {
						// Filter by suffix if provided
						if (suffix && !item.Key.toLowerCase().endsWith(suffix.toLowerCase())) {
							continue;
						}
						objects.push({
							key: item.Key,
							size: item.Size,
							lastModified: item.LastModified,
						});
					}
				}
			}

			continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
		} while (continuationToken);

		return objects;
	}

	async copy(sourcePath: string, destinationPath: string): Promise<void> {
		const command = new CopyObjectCommand({
			Bucket: this.bucket,
			CopySource: `${this.bucket}/${sourcePath}`,
			Key: destinationPath,
		});

		await this.client.send(command);
	}
}
