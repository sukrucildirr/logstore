import { EthereumAddress, Logger } from '@streamr/utils';
import {
	StorageNodeAssignmentEvent,
	Stream,
	StreamrClient,
} from 'streamr-client';

const logger = new Logger(module);

/**
 * Hooks up to StreamrClient event listener to learn about
 * stream assignment and removal events in real-time.
 */
export class LogStoreEventListener {
	private readonly clusterId: EthereumAddress;
	private readonly streamrClient: StreamrClient;
	private readonly onEvent: (
		stream: Stream,
		type: 'added' | 'removed',
		block: number
	) => void;
	private readonly onAddToStorageNode: (
		event: StorageNodeAssignmentEvent
	) => void;
	private readonly onRemoveFromStorageNode: (
		event: StorageNodeAssignmentEvent
	) => void;

	constructor(
		clusterId: EthereumAddress,
		streamrClient: StreamrClient,
		onEvent: (stream: Stream, type: 'added' | 'removed', block: number) => void
	) {
		this.clusterId = clusterId;
		this.streamrClient = streamrClient;
		this.onEvent = onEvent;
		this.onAddToStorageNode = (event: StorageNodeAssignmentEvent) =>
			this.handleEvent(event, 'added');
		this.onRemoveFromStorageNode = (event: StorageNodeAssignmentEvent) =>
			this.handleEvent(event, 'removed');
	}

	private async handleEvent(
		event: StorageNodeAssignmentEvent,
		type: 'added' | 'removed'
	) {
		if (event.nodeAddress !== this.clusterId) {
			return;
		}
		logger.info('received StorageNodeAssignmentEvent type=%s: %j', type, event);
		try {
			const stream = await this.streamrClient.getStream(event.streamId);
			this.onEvent(stream, type, event.blockNumber);
		} catch (e) {
			logger.warn('chainEventsListener: %s', e);
		}
	}

	async start(): Promise<void> {
		this.streamrClient.on('addToStorageNode', this.onAddToStorageNode);
		this.streamrClient.on(
			'removeFromStorageNode',
			this.onRemoveFromStorageNode
		);
	}

	async destroy(): Promise<void> {
		this.streamrClient.off('addToStorageNode', this.onAddToStorageNode);
		this.streamrClient.off(
			'removeFromStorageNode',
			this.onRemoveFromStorageNode
		);
	}
}
