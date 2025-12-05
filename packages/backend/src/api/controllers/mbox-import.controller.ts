import { Request, Response } from 'express';
import { MboxImportService, MboxImportResult } from '../../services/MboxImportService';
import { logger } from '../../config/logger';
import { config } from '../../config/index';

export class MboxImportController {
	private mboxImportService: MboxImportService;

	constructor() {
		this.mboxImportService = new MboxImportService();
	}

	/**
	 * Trigger MBOX file import from the configured uploads folder.
	 * POST /api/v1/import/mbox
	 */
	public importMboxFiles = async (req: Request, res: Response): Promise<Response> => {
		try {
			logger.info(
				{
					uploadsPrefix: config.mboxImport.uploadsPrefix,
					postProcessAction: config.mboxImport.postProcessAction,
				},
				'Starting MBOX import process'
			);

			const result: MboxImportResult = await this.mboxImportService.importMboxFiles();

			// Determine HTTP status code based on result
			let statusCode = 200;
			let message = 'MBOX import completed successfully';

			if (result.filesFound === 0) {
				message = 'No MBOX files found in the uploads folder';
			} else if (result.filesFailed > 0 && result.filesProcessed === 0) {
				statusCode = 500;
				message = 'MBOX import failed for all files';
			} else if (result.filesFailed > 0) {
				statusCode = 207; // Multi-Status
				message = 'MBOX import completed with some failures';
			}

			return res.status(statusCode).json({
				message,
				...result,
			});
		} catch (error) {
			logger.error({ error }, 'MBOX import failed');
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return res.status(500).json({
				message: 'MBOX import failed',
				error: errorMessage,
			});
		}
	};

	/**
	 * Get the current MBOX import configuration.
	 * GET /api/v1/import/mbox/config
	 */
	public getConfig = async (req: Request, res: Response): Promise<Response> => {
		return res.status(200).json({
			uploadsPrefix: config.mboxImport.uploadsPrefix,
			postProcessAction: config.mboxImport.postProcessAction,
			processedPrefix: config.mboxImport.processedPrefix,
		});
	};
}
