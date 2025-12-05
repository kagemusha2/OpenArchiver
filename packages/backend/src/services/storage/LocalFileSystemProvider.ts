import { IStorageProvider, LocalStorageConfig, StorageObject } from '@open-archiver/types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export class LocalFileSystemProvider implements IStorageProvider {
	private readonly rootPath: string;

	constructor(config: LocalStorageConfig) {
		this.rootPath = config.rootPath;
	}

	async put(filePath: string, content: Buffer | NodeJS.ReadableStream): Promise<void> {
		const fullPath = path.join(this.rootPath, filePath);
		const dir = path.dirname(fullPath);
		await fs.mkdir(dir, { recursive: true });

		if (Buffer.isBuffer(content)) {
			await fs.writeFile(fullPath, content);
		} else {
			const writeStream = createWriteStream(fullPath);
			await pipeline(content, writeStream);
		}
	}

	async get(filePath: string): Promise<NodeJS.ReadableStream> {
		const fullPath = path.join(this.rootPath, filePath);
		try {
			await fs.access(fullPath);
			return createReadStream(fullPath);
		} catch (error) {
			throw new Error('File not found');
		}
	}

	async delete(filePath: string): Promise<void> {
		const fullPath = path.join(this.rootPath, filePath);
		try {
			await fs.rm(fullPath, { recursive: true, force: true });
		} catch (error: any) {
			// Even with force: true, other errors might occur (e.g., permissions)
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}

	async exists(filePath: string): Promise<boolean> {
		const fullPath = path.join(this.rootPath, filePath);
		try {
			await fs.access(fullPath);
			return true;
		} catch {
			return false;
		}
	}

	async list(prefix: string, suffix?: string): Promise<StorageObject[]> {
		const fullPath = path.join(this.rootPath, prefix);
		const objects: StorageObject[] = [];

		try {
			await fs.access(fullPath);
		} catch {
			// Directory doesn't exist
			return objects;
		}

		const walkDirectory = async (dir: string): Promise<void> => {
			const entries = await fs.readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const entryPath = path.join(dir, entry.name);
				const relativePath = path.relative(this.rootPath, entryPath);

				if (entry.isDirectory()) {
					await walkDirectory(entryPath);
				} else if (entry.isFile()) {
					// Filter by suffix if provided
					if (suffix && !entry.name.toLowerCase().endsWith(suffix.toLowerCase())) {
						continue;
					}
					const stat = await fs.stat(entryPath);
					objects.push({
						key: relativePath,
						size: stat.size,
						lastModified: stat.mtime,
					});
				}
			}
		};

		await walkDirectory(fullPath);
		return objects;
	}

	async copy(sourcePath: string, destinationPath: string): Promise<void> {
		const fullSourcePath = path.join(this.rootPath, sourcePath);
		const fullDestPath = path.join(this.rootPath, destinationPath);

		// Ensure destination directory exists
		const destDir = path.dirname(fullDestPath);
		await fs.mkdir(destDir, { recursive: true });

		await fs.copyFile(fullSourcePath, fullDestPath);
	}
}
