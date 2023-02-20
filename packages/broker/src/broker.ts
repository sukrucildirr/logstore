import { Logger, toEthereumAddress } from '@streamr/utils';
import { Server as HttpServer } from 'http';
import { Server as HttpsServer } from 'https';
import StreamrClient, {
	NetworkNodeStub,
	validateConfig as validateClientConfig,
} from 'streamr-client';
import { version as CURRENT_VERSION } from '../package.json';
import { createApiAuthenticator } from './apiAuthenticator';
import { Config } from './config/config';
import BROKER_CONFIG_SCHEMA from './config/config.schema.json';
import { validateConfig } from './config/validateConfig';
import { generateMnemonicFromAddress } from './helpers/generateMnemonicFromAddress';
import { startServer as startHttpServer, stopServer } from './httpServer';
import { Plugin, PluginOptions } from './Plugin';
import { createPlugin } from './pluginRegistry';

const logger = new Logger(module);

export interface Broker {
	getNode: () => Promise<NetworkNodeStub>;
	start: () => Promise<unknown>;
	stop: () => Promise<unknown>;
}

export const createBroker = async (
	configWithoutDefaults: Config
): Promise<Broker> => {
	const config = validateConfig(configWithoutDefaults, BROKER_CONFIG_SCHEMA);
	validateClientConfig(config.client);

	const streamrClient = new StreamrClient(config.client);
	const apiAuthenticator = createApiAuthenticator(config);

	const plugins: Plugin<any>[] = Object.keys(config.plugins).map((name) => {
		const pluginOptions: PluginOptions = {
			name,
			streamrClient,
			apiAuthenticator,
			brokerConfig: config,
		};
		return createPlugin(name, pluginOptions);
	});

	let started = false;
	let httpServer: HttpServer | HttpsServer | undefined;

	const getNode = async (): Promise<NetworkNodeStub> => {
		if (!started) {
			throw new Error('cannot invoke on non-started broker');
		}
		return streamrClient.getNode();
	};

	return {
		getNode,
		start: async () => {
			logger.info(`Starting broker version ${CURRENT_VERSION}`);
			await Promise.all(plugins.map((plugin) => plugin.start()));
			const httpServerRoutes = plugins.flatMap((plugin) =>
				plugin.getHttpServerRoutes()
			);
			if (httpServerRoutes.length > 0) {
				httpServer = await startHttpServer(
					httpServerRoutes,
					config.httpServer,
					apiAuthenticator
				);
			}

			const nodeId = (await streamrClient.getNode()).getNodeId();
			const brokerAddress = await streamrClient.getAddress();
			const mnemonic = generateMnemonicFromAddress(
				toEthereumAddress(brokerAddress)
			);

			logger.info(
				`Welcome to the Streamr Network. Your node's generated name is ${mnemonic}.`
			);
			logger.info(
				`View your node in the Network Explorer: https://streamr.network/network-explorer/nodes/${encodeURIComponent(
					nodeId
				)}`
			);
			logger.info(`Network node ${nodeId} running`);
			logger.info(`Ethereum address ${brokerAddress}`);
			logger.info(
				`Tracker Configuration: ${
					config.client.network?.trackers
						? JSON.stringify(config.client.network?.trackers)
						: 'default'
				}`
			);

			logger.info(`Plugins: ${JSON.stringify(plugins.map((p) => p.name))}`);

			if (
				config.client.network?.webrtcDisallowPrivateAddresses === undefined ||
				config.client.network.webrtcDisallowPrivateAddresses
			) {
				logger.warn(
					'WebRTC private address probing is disabled. ' +
						'This makes it impossible to create network layer connections directly via local routers ' +
						'More info: https://github.com/streamr-dev/network-monorepo/wiki/WebRTC-private-addresses'
				);
			}
			started = true;
		},
		stop: async () => {
			if (httpServer !== undefined) {
				await stopServer(httpServer);
			}
			await Promise.all(plugins.map((plugin) => plugin.stop()));
			await streamrClient.destroy();
		},
	};
};

process.on('uncaughtException', (err) => {
	logger.getFinalLogger().error(err, 'uncaughtException');
	process.exit(1);
});

process.on('unhandledRejection', (err) => {
	logger.getFinalLogger().error(err, 'unhandledRejection');
	process.exit(1);
});
