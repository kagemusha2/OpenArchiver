import 'dotenv/config';

export type MboxPostProcessAction = 'move' | 'delete' | 'keep';

export const mboxImportConfig = {
	/**
	 * The S3 prefix (folder) where MBOX files are uploaded.
	 * Default: 'Uploads/'
	 */
	uploadsPrefix: process.env.S3_UPLOADS_PREFIX || 'Uploads/',
	/**
	 * The action to perform on MBOX files after processing.
	 * - 'move': Move to processed folder (default)
	 * - 'delete': Delete the file
	 * - 'keep': Keep the file in the original location
	 */
	postProcessAction: (process.env.S3_MBOX_POST_PROCESS_ACTION || 'move') as MboxPostProcessAction,
	/**
	 * The prefix for processed files when using 'move' action.
	 */
	processedPrefix: 'Uploads/processed/',
};
