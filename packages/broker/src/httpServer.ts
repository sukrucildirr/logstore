import { Logger } from '@streamr/utils';
import cors from 'cors';
import { once } from 'events';
import express, { Request, Response } from 'express';
import fs from 'fs';
import { Server as HttpServer } from 'http';
import https, { Server as HttpsServer } from 'https';

import { ApiAuthenticator } from './apiAuthenticator';
import { StrictConfig } from './config/config';

const logger = new Logger(module);

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;

const getApiKey = (req: Request) => {
	const headerValue = req.headers.authorization;
	const PREFIX = 'bearer ';
	if (headerValue?.toLowerCase().startsWith(PREFIX)) {
		return headerValue.substring(PREFIX.length);
	}
	return undefined;
};

const createAuthenticatorMiddleware = (apiAuthenticator: ApiAuthenticator) => {
	return (req: Request, res: Response, next: () => void) => {
		const apiKey = getApiKey(req);
		if (apiAuthenticator.isValidAuthentication(apiKey)) {
			next();
		} else {
			const status =
				apiKey === undefined ? HTTP_STATUS_UNAUTHORIZED : HTTP_STATUS_FORBIDDEN;
			res.sendStatus(status);
		}
	};
};

export const startServer = async (
	routers: express.Router[],
	config: StrictConfig['httpServer'],
	apiAuthenticator: ApiAuthenticator
): Promise<HttpServer | https.Server> => {
	const app = express();
	app.use(
		cors({
			origin: true, // Access-Control-Allow-Origin: request origin. The default '*' is invalid if credentials included.
			credentials: true, // Access-Control-Allow-Credentials: true
		})
	);
	app.use(createAuthenticatorMiddleware(apiAuthenticator));
	routers.forEach((router) => app.use(router));
	let serverFactory: { listen: (port: number) => HttpServer | HttpsServer };
	if (config.sslCertificate !== undefined) {
		serverFactory = https.createServer(
			{
				cert: fs.readFileSync(config.sslCertificate.certFileName),
				key: fs.readFileSync(config.sslCertificate.privateKeyFileName),
			},
			app
		);
	} else {
		serverFactory = app;
	}
	const server = serverFactory.listen(config.port);
	await once(server, 'listening');
	logger.info(`HTTP server listening on ${config.port}`);
	return server;
};

export const stopServer = async (
	httpServer: HttpServer | HttpsServer
): Promise<void> => {
	if (httpServer.listening) {
		httpServer.close();
		await once(httpServer, 'close');
	}
};
