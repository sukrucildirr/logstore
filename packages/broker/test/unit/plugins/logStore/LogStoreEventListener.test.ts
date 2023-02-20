import { toStreamID } from '@streamr/protocol';
import { LogStoreEventListener } from '../../../../src/plugins/logStore/LogStoreEventListener';
import {
	StorageNodeAssignmentEvent,
	Stream,
	StreamrClient,
	StreamrClientEvents,
} from 'streamr-client';
import { EthereumAddress, toEthereumAddress, wait } from '@streamr/utils';

const MOCK_STREAM = {
	id: 'streamId',
	getMetadata: () => ({
		partitions: 3,
	}),
} as Stream;
const clusterId = toEthereumAddress(
	'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);
const otherClusterId = toEthereumAddress(
	'0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
);

describe(LogStoreEventListener, () => {
	let stubClient: Pick<StreamrClient, 'getStream' | 'on' | 'off'>;
	const storageEventListeners: Map<
		keyof StreamrClientEvents,
		(event: StorageNodeAssignmentEvent) => any
	> = new Map();
	let onEvent: jest.Mock<
		void,
		[stream: Stream, type: 'added' | 'removed', block: number]
	>;
	let listener: LogStoreEventListener;

	beforeEach(() => {
		stubClient = {
			async getStream() {
				return MOCK_STREAM;
			},
			on(eventName: keyof StreamrClientEvents, listener: any) {
				storageEventListeners.set(eventName, listener);
			},
			off: jest.fn(),
		};
		onEvent = jest.fn();
		listener = new LogStoreEventListener(
			clusterId,
			stubClient as StreamrClient,
			onEvent
		);
	});

	afterEach(() => {
		listener?.destroy();
	});

	it('start() registers storage event listener on client', async () => {
		expect(storageEventListeners.size).toBe(0);
		await listener.start();
		expect(storageEventListeners.size).toBe(2);
	});

	it('destroy() unregisters storage event listener on client', async () => {
		expect(stubClient.off).toHaveBeenCalledTimes(0);
		await listener.destroy();
		expect(stubClient.off).toHaveBeenCalledTimes(2);
	});

	function addToStorageNode(recipient: EthereumAddress) {
		storageEventListeners.get('addToStorageNode')!({
			nodeAddress: recipient,
			streamId: toStreamID('streamId'),
			blockNumber: 1234,
		});
	}

	it('storage node assignment event gets passed to onEvent', async () => {
		await listener.start();
		addToStorageNode(clusterId);
		await wait(0);
		expect(onEvent).toHaveBeenCalledTimes(1);
		expect(onEvent).toHaveBeenCalledWith(MOCK_STREAM, 'added', 1234);
	});

	it('storage node assignment events meant for another recipient are ignored', async () => {
		await listener.start();
		addToStorageNode(otherClusterId);
		await wait(0);
		expect(onEvent).toHaveBeenCalledTimes(0);
	});
});
