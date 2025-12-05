import { Router } from 'express';
import { MboxImportController } from '../controllers/mbox-import.controller';
import { requireAuth } from '../middleware/requireAuth';
import { requirePermission } from '../middleware/requirePermission';
import { AuthService } from '../../services/AuthService';

export const createMboxImportRouter = (authService: AuthService): Router => {
	const router = Router();
	const controller = new MboxImportController();

	// Require authentication and ingestion creation permission
	router.use(requireAuth(authService));

	/**
	 * POST /api/v1/import/mbox
	 * Trigger MBOX file import from the configured uploads folder.
	 * Requires 'create' permission on 'ingestion' resource.
	 */
	router.post('/', requirePermission('create', 'ingestion'), controller.importMboxFiles);

	/**
	 * GET /api/v1/import/mbox/config
	 * Get the current MBOX import configuration.
	 * Requires 'read' permission on 'ingestion' resource.
	 */
	router.get('/config', requirePermission('read', 'ingestion'), controller.getConfig);

	return router;
};
