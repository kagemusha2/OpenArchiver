// packages/types/src/storage.types.ts

/**
 * Represents a file object returned by the list operation.
 */
export interface StorageObject {
	key: string;
	size?: number;
	lastModified?: Date;
}

/**
 * Defines the contract that all storage providers must implement.
 * It uses streams to efficiently handle potentially large files without
 * loading them entirely into memory.
 */
export interface IStorageProvider {
	/**
	 * Stores a file at the specified path.
	 * @param path - The unique identifier for the file (e.g., "user-123/emails/message-abc.eml").
	 * @param content - The file content as a Buffer or a ReadableStream.
	 * @returns A promise that resolves when the file is successfully stored.
	 */
	put(path: string, content: Buffer | NodeJS.ReadableStream): Promise<void>;

	/**
	 * Retrieves a file from the specified path as a readable stream.
	 * @param path - The unique identifier for the file to retrieve.
	 * @returns A promise that resolves with a readable stream of the file's content.
	 * @throws {Error} If the file is not found.
	 */
	get(path: string): Promise<NodeJS.ReadableStream>;

	/**
	 * Deletes a file from the storage backend.
	 * @param path - The unique identifier for the file to delete.
	 * @returns A promise that resolves when the file is deleted.
	 */
	delete(path: string): Promise<void>;

	/**
	 * Checks for the existence of a file.
	 * @param path - The unique identifier for the file to check.
	 * @returns A promise that resolves with true if the file exists, false otherwise.
	 */
	exists(path: string): Promise<boolean>;

	/**
	 * Lists all files under a given prefix (optional).
	 * @param prefix - The prefix to filter files by.
	 * @param suffix - Optional suffix to filter files by (e.g., '.mbox').
	 * @returns A promise that resolves with an array of storage objects.
	 */
	list?(prefix: string, suffix?: string): Promise<StorageObject[]>;

	/**
	 * Copies a file from one path to another (optional).
	 * @param sourcePath - The source path of the file.
	 * @param destinationPath - The destination path for the file.
	 * @returns A promise that resolves when the file is copied.
	 */
	copy?(sourcePath: string, destinationPath: string): Promise<void>;
}

/**
 * Configuration for the Local Filesystem provider.
 */
export interface LocalStorageConfig {
	type: 'local';
	// The absolute root path on the server where the archive will be stored.
	rootPath: string;
	openArchiverFolderName: string;
	encryptionKey?: string;
}

/**
 * Configuration for any S3-compatible provider (AWS S3, MinIO, etc.).
 */
export interface S3StorageConfig {
	type: 's3';
	// The API endpoint. For AWS S3, this is region-specific (e.g., 'https://s3.us-east-1.amazonaws.com').
	// For MinIO, this is the address of your MinIO server (e.g., 'http://localhost:9000').
	endpoint: string;
	// The name of the bucket to use.
	bucket: string;
	// The access key ID for authentication.
	accessKeyId: string;
	// The secret access key for authentication.
	secretAccessKey: string;
	// The AWS region (optional but recommended for AWS S3).
	region?: string;
	// Force path-style addressing, required for MinIO.
	forcePathStyle?: boolean;
	openArchiverFolderName: string;
	encryptionKey?: string;
}

export type StorageConfig = LocalStorageConfig | S3StorageConfig;
