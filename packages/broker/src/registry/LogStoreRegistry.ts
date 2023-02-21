import { Provider } from '@ethersproject/providers';
import { StreamID, toStreamID } from '@streamr/protocol';
import { EthereumAddress, Logger, toEthereumAddress } from '@streamr/utils';
// TODO: Get back StreamFactory
// import { StreamFactory } from '../client/StreamFactory'
import { min } from 'lodash';
import { Stream } from 'streamr-client';
import { inject, Lifecycle, scoped } from 'tsyringe';

import {
	Authentication,
	AuthenticationInjectionToken,
} from '../client/Authentication';
import {
	ConfigInjectionToken,
	StrictStreamrClientConfig,
} from '../client/Config';
import { ContractFactory } from '../client/ContractFactory';
import {
	getStreamRegistryChainProviders,
	getStreamRegistryOverrides,
} from '../client/Ethereum';
import {
	initEventGateway,
	StreamrClientEventEmitter,
	StreamrClientEvents,
} from '../client/events';
import { StreamIDBuilder } from '../client/StreamIDBuilder';
import { queryAllReadonlyContracts, waitForTx } from '../client/utils/contract';
import { collect } from '../client/utils/iterators';
import { LoggerFactory } from '../client/utils/LoggerFactory';
import { SynchronizedGraphQLClient } from '../client/utils/SynchronizedGraphQLClient';
import type { StreamStorageRegistryV2 as StreamStorageRegistryContract } from '../ethereumArtifacts/StreamStorageRegistryV2';
import StreamStorageRegistryArtifact from '../ethereumArtifacts/StreamStorageRegistryV2Abi.json';

export interface StorageNodeAssignmentEvent {
	readonly streamId: StreamID;
	readonly nodeAddress: EthereumAddress;
	readonly blockNumber: number;
}

interface NodeQueryResult {
	id: string;
	metadata: string;
	lastseen: string;
}

/**
 * Stores storage node assignments (mapping of streamIds <-> storage nodes addresses)
 */
@scoped(Lifecycle.ContainerScoped)
export class LogStoreRegistry {
	private contractFactory: ContractFactory;
	// TODO: Get back StreamFactory
	// private streamFactory: StreamFactory
	private streamIdBuilder: StreamIDBuilder;
	private graphQLClient: SynchronizedGraphQLClient;
	private authentication: Authentication;
	private streamStorageRegistryContract?: StreamStorageRegistryContract;
	private config: Pick<StrictStreamrClientConfig, 'contracts'>;
	private readonly streamStorageRegistryContractsReadonly: StreamStorageRegistryContract[];
	private readonly logger: Logger;

	constructor(
		contractFactory: ContractFactory,
		// TODO: Get back StreamFactory
		// @inject(delay(() => StreamFactory)) streamFactory: StreamFactory,
		@inject(StreamIDBuilder) streamIdBuilder: StreamIDBuilder,
		@inject(SynchronizedGraphQLClient) graphQLClient: SynchronizedGraphQLClient,
		@inject(StreamrClientEventEmitter) eventEmitter: StreamrClientEventEmitter,
		@inject(AuthenticationInjectionToken) authentication: Authentication,
		@inject(LoggerFactory) loggerFactory: LoggerFactory,
		@inject(ConfigInjectionToken)
		config: Pick<StrictStreamrClientConfig, 'contracts'>
	) {
		this.contractFactory = contractFactory;
		// TODO: Get back StreamFactory
		// this.streamFactory = streamFactory
		this.streamIdBuilder = streamIdBuilder;
		this.graphQLClient = graphQLClient;
		this.authentication = authentication;
		this.config = config;
		this.logger = loggerFactory.createLogger(module);
		this.streamStorageRegistryContractsReadonly =
			getStreamRegistryChainProviders(config).map((provider: Provider) => {
				return this.contractFactory.createReadContract(
					toEthereumAddress(
						this.config.contracts.streamStorageRegistryChainAddress
					),
					StreamStorageRegistryArtifact,
					provider,
					'streamStorageRegistry'
				) as StreamStorageRegistryContract;
			});
		this.initStreamAssignmentEventListener(
			'addToStorageNode',
			'Added',
			eventEmitter
		);
		this.initStreamAssignmentEventListener(
			'removeFromStorageNode',
			'Removed',
			eventEmitter
		);
	}

	private initStreamAssignmentEventListener(
		clientEvent: keyof StreamrClientEvents,
		contractEvent: string,
		eventEmitter: StreamrClientEventEmitter
	) {
		const primaryReadonlyContract =
			this.streamStorageRegistryContractsReadonly[0];
		type Listener = (streamId: string, nodeAddress: string, extra: any) => void;
		initEventGateway(
			clientEvent,
			(emit: (payload: StorageNodeAssignmentEvent) => void) => {
				const listener = (
					streamId: string,
					nodeAddress: string,
					extra: any
				) => {
					emit({
						streamId: toStreamID(streamId),
						nodeAddress: toEthereumAddress(nodeAddress),
						blockNumber: extra.blockNumber,
					});
				};
				primaryReadonlyContract.on(contractEvent, listener);
				return listener;
			},
			(listener: Listener) => {
				primaryReadonlyContract.off(contractEvent, listener);
			},
			eventEmitter
		);
	}

	private async connectToContract() {
		if (!this.streamStorageRegistryContract) {
			const chainSigner =
				await this.authentication.getStreamRegistryChainSigner();
			this.streamStorageRegistryContract =
				this.contractFactory.createWriteContract<StreamStorageRegistryContract>(
					toEthereumAddress(
						this.config.contracts.streamStorageRegistryChainAddress
					),
					StreamStorageRegistryArtifact,
					chainSigner,
					'streamStorageRegistry'
				);
		}
	}

	async addStreamToStorageNode(
		streamIdOrPath: string,
		nodeAddress: EthereumAddress
	): Promise<void> {
		const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath);
		this.logger.debug('adding stream %s to node %s', streamId, nodeAddress);
		await this.connectToContract();
		const ethersOverrides = getStreamRegistryOverrides(this.config);
		await waitForTx(
			this.streamStorageRegistryContract!.addStorageNode(
				streamId,
				nodeAddress,
				ethersOverrides
			)
		);
	}

	async removeStreamFromStorageNode(
		streamIdOrPath: string,
		nodeAddress: EthereumAddress
	): Promise<void> {
		const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath);
		this.logger.debug('removing stream %s from node %s', streamId, nodeAddress);
		await this.connectToContract();
		const ethersOverrides = getStreamRegistryOverrides(this.config);
		await waitForTx(
			this.streamStorageRegistryContract!.removeStorageNode(
				streamId,
				nodeAddress,
				ethersOverrides
			)
		);
	}

	async isStoredStream(
		streamIdOrPath: string,
		nodeAddress: EthereumAddress
	): Promise<boolean> {
		const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath);
		this.logger.debug(
			'querying if stream %s is stored in storage node %s',
			streamId,
			nodeAddress
		);
		return queryAllReadonlyContracts(
			(contract: StreamStorageRegistryContract) => {
				return contract.isStorageNodeOf(streamId, nodeAddress);
			},
			this.streamStorageRegistryContractsReadonly
		);
	}

	async getStoredStreams(
		nodeAddress: EthereumAddress
	): Promise<{ streams: Stream[]; blockNumber: number }> {
		this.logger.debug('getting stored streams of node %s', nodeAddress);
		const blockNumbers: number[] = [];
		// const res = await collect(
		await collect(
			this.graphQLClient.fetchPaginatedResults(
				(lastId: string, pageSize: number) => {
					const query = `{
                    node (id: "${nodeAddress}") {
                        id
                        metadata
                        lastSeen
                        storedStreams (first: ${pageSize} orderBy: "id" where: { id_gt: "${lastId}"}) {
                            id,
                            metadata
                        }
                    }
                    _meta {
                        block {
                            number
                        }
                    }
                }`;
					return { query };
				},
				(response: any) => {
					// eslint-disable-next-line no-underscore-dangle
					blockNumbers.push(response._meta.block.number);
					return response.node !== null ? response.node.storedStreams : [];
				}
			)
		);
		const streams: Stream[] = [];
		// TODO: Get back StreamFactory
		// const streams = res.map((stream: any) => {
		//     const props = Stream.parseMetadata(stream.metadata)
		//     return this.streamFactory.createStream(toStreamID(stream.id), props) // toStreamID() not strictly necessary
		// })
		return {
			streams,
			blockNumber: min(blockNumbers)!,
		};
	}

	async getStorageNodes(streamIdOrPath?: string): Promise<EthereumAddress[]> {
		let queryResults: NodeQueryResult[];
		if (streamIdOrPath !== undefined) {
			const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath);
			this.logger.debug('getting storage nodes of stream %s', streamId);
			queryResults = await collect(
				this.graphQLClient.fetchPaginatedResults<NodeQueryResult>(
					(lastId: string, pageSize: number) => {
						const query = `{
                        stream (id: "${streamId}") {
                            id
                            metadata
                            storageNodes (first: ${pageSize} orderBy: "id" where: { id_gt: "${lastId}"}) {
                                id
                                metadata
                                lastSeen
                            }
                        }
                    }`;
						return { query };
					},
					(response: any) => {
						return response.stream !== null ? response.stream.storageNodes : [];
					}
				)
			);
		} else {
			this.logger.debug('getting all storage nodes');
			queryResults = await collect(
				this.graphQLClient.fetchPaginatedResults<NodeQueryResult>(
					(lastId: string, pageSize: number) => {
						const query = `{
                        nodes (first: ${pageSize} orderBy: "id" where: { id_gt: "${lastId}"}) {
                            id
                            metadata
                            lastSeen
                        }
                    }`;
						return { query };
					}
				)
			);
		}
		return queryResults.map((node) => toEthereumAddress(node.id));
	}
}
