import { ExposedPromise } from '../../utils/exposed-promise'

import { Logger } from '../../utils/Logger'
import { generateGUID } from '../../utils/generate-uuid'
import { BeaconEvent, BeaconEventHandlerFunction, BeaconEventType } from '../../events'
import { BEACON_VERSION } from '../../constants'
import { getAddressFromPublicKey } from '../../utils/crypto'
import { ConnectionContext } from '../../types/ConnectionContext'
import {
  AccountInfo,
  Client,
  TransportType,
  Transport,
  StorageKey,
  BeaconMessageType,
  PermissionScope,
  PermissionResponse,
  NetworkType,
  SignPayloadResponse,
  SignPayloadRequest,
  OperationResponse,
  OperationRequest,
  BroadcastResponse,
  BroadcastRequest,
  BeaconErrorMessage,
  BeaconMessage,
  RequestPermissionInput,
  RequestSignPayloadInput,
  RequestOperationInput,
  RequestBroadcastInput,
  PermissionRequest,
  AppMetadata,
  Serializer,
  LocalStorage,
  PermissionResponseOutput,
  PermissionRequestInput,
  SignPayloadResponseOutput,
  SignPayloadRequestInput,
  OperationResponseOutput,
  OperationRequestInput,
  BroadcastResponseOutput,
  BroadcastRequestInput,
  BeaconRequestInputMessage,
  Network,
  P2PPairInfo,
  P2PTransport,
  BeaconError
} from '../..'
import { messageEvents } from '../../beacon-message-events'
import { IgnoredRequestInputProperties } from '../../types/beacon/messages/BeaconRequestInputMessage'
import { checkPermissions } from '../../utils/check-permissions'
import { getAccountIdentifier } from '../../utils/get-account-identifier'
import { DAppClientOptions } from './DAppClientOptions'

const logger = new Logger('DAppClient')

export class DAppClient extends Client {
  private readonly openRequests = new Map<
    string,
    ExposedPromise<
      { message: BeaconMessage; connectionInfo: ConnectionContext },
      BeaconErrorMessage
    >
  >()
  private readonly iconUrl?: string

  private activeAccount: AccountInfo | undefined

  public get isConnected(): Promise<boolean> {
    return this._isConnected.promise
  }

  constructor(config: DAppClientOptions) {
    super({
      storage: config.storage ? config.storage : new LocalStorage(),
      ...config
    })
    this.iconUrl = config.iconUrl

    this.storage
      .get(StorageKey.ACTIVE_ACCOUNT)
      .then(async (activeAccount) => {
        if (activeAccount) {
          await this.setActiveAccount(await this.accountManager.getAccount(activeAccount))
        }
      })
      .catch((storageError) => {
        console.error(storageError)
      })

    this.handleResponse = (event: BeaconMessage, connectionInfo: ConnectionContext): void => {
      const openRequest = this.openRequests.get(event.id)
      if (openRequest) {
        logger.log('handleResponse', 'found openRequest', event.id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errorMessage: BeaconErrorMessage = (event as any) as BeaconErrorMessage
        if (errorMessage.errorType) {
          openRequest.reject(errorMessage)
        } else {
          openRequest.resolve({ message: event, connectionInfo })
        }
        this.openRequests.delete(event.id)
      } else {
        logger.error('handleResponse', 'no request found for id ', event.id)
      }
    }
  }

  public addOpenRequest(
    id: string,
    promise: ExposedPromise<
      { message: BeaconMessage; connectionInfo: ConnectionContext },
      BeaconErrorMessage
    >
  ): void {
    logger.log('addOpenRequest', this.name, `adding request ${id} and waiting for answer`)
    this.openRequests.set(id, promise)
  }

  public async init(_isDapp?: boolean, transport?: Transport): Promise<TransportType> {
    const initResponse = await super.init(true, transport)

    return initResponse
  }

  public async getActiveAccount(): Promise<AccountInfo | undefined> {
    return this.activeAccount
  }

  public async setActiveAccount(account?: AccountInfo): Promise<void> {
    this.activeAccount = account

    await this.storage.set(
      StorageKey.ACTIVE_ACCOUNT,
      account ? account.accountIdentifier : undefined
    )

    await this.events.emit(BeaconEvent.ACTIVE_ACCOUNT_SET, account)

    return
  }

  public async getAppMetadata(): Promise<AppMetadata> {
    return {
      beaconId: await this.beaconId,
      name: this.name,
      icon: this.iconUrl
    }
  }

  public async connect(): Promise<boolean> {
    return super._connect()
  }

  public async removeAccount(accountIdentifier: string): Promise<void> {
    const removeAccountResult = super.removeAccount(accountIdentifier)
    if (this.activeAccount && this.activeAccount.accountIdentifier === accountIdentifier) {
      await this.setActiveAccount(undefined)
    }

    return removeAccountResult
  }

  public async removePeer(id: P2PPairInfo): Promise<void> {
    if ((await this.transport).type === TransportType.P2P) {
      const removePeerResult = ((await this.transport) as P2PTransport).removePeer(id)

      await this.removeAccountsForPeers([id])

      return removePeerResult
    }
  }

  public async removeAllPeers(): Promise<void> {
    if ((await this.transport).type === TransportType.P2P) {
      const peers: P2PPairInfo[] = await ((await this.transport) as P2PTransport).getPeers()
      const removePeerResult = ((await this.transport) as P2PTransport).removeAllPeers()

      await this.removeAccountsForPeers(peers)

      return removePeerResult
    }
  }

  public async subscribeToEvent<K extends BeaconEvent>(
    internalEvent: K,
    eventCallback: BeaconEventHandlerFunction<BeaconEventType[K]>
  ): Promise<void> {
    await this.events.on(internalEvent, eventCallback)
  }

  public async checkPermissions(type: BeaconMessageType): Promise<boolean> {
    if (type === BeaconMessageType.PermissionRequest) {
      return true
    }

    const accountInfo = this.activeAccount

    if (!accountInfo) {
      throw this.sendInternalError('No active account set!')
    }

    const permissions = accountInfo.scopes

    return checkPermissions(type, permissions)
  }

  /**
   * Permission request
   */
  public async requestPermissions(
    input?: RequestPermissionInput
  ): Promise<PermissionResponseOutput> {
    const request: PermissionRequestInput = {
      appMetadata: await this.getAppMetadata(),
      type: BeaconMessageType.PermissionRequest,
      network: input && input.network ? input.network : { type: NetworkType.MAINNET },
      scopes:
        input && input.scopes
          ? input.scopes
          : [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN]
    }

    const { message, connectionInfo } = await this.makeRequest<
      PermissionRequest,
      PermissionResponse
    >(request).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })

    // TODO: Migration code. Remove before 1.0.0 release.
    const publicKey = message.publicKey || (message as any).pubkey || (message as any).pubKey
    const address = await getAddressFromPublicKey(publicKey)

    const accountInfo: AccountInfo = {
      accountIdentifier: await getAccountIdentifier(address, message.network),
      beaconId: message.beaconId,
      origin: {
        type: connectionInfo.origin,
        id: connectionInfo.id
      },
      address,
      publicKey,
      network: message.network,
      scopes: message.scopes,
      connectedAt: new Date().getTime()
    }

    await this.accountManager.addAccount(accountInfo)
    await this.setActiveAccount(accountInfo)
    console.log('permissions interception', { message, connectionInfo })

    const { beaconId, network, scopes } = message

    const output: PermissionResponseOutput = { beaconId, address, network, scopes }

    await this.notifySuccess(request, {
      account: accountInfo,
      output,
      connectionContext: connectionInfo
    })

    return output
  }

  /**
   * Sign request
   */
  public async requestSignPayload(
    input: RequestSignPayloadInput
  ): Promise<SignPayloadResponseOutput> {
    if (!input.payload) {
      throw this.sendInternalError('Payload must be provided')
    }
    if (!this.activeAccount) {
      throw this.sendInternalError('No active account!')
    }

    const activeAccount = this.activeAccount

    const request: SignPayloadRequestInput = {
      type: BeaconMessageType.SignPayloadRequest,
      payload: input.payload,
      sourceAddress: input.sourceAddress || activeAccount.address
    }

    const { message, connectionInfo } = await this.makeRequest<
      SignPayloadRequest,
      SignPayloadResponse
    >(request).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })

    const { beaconId, signature } = message

    const output: SignPayloadResponseOutput = { beaconId, signature }

    await this.notifySuccess(request, {
      account: activeAccount,
      output,
      connectionContext: connectionInfo
    })

    return output
  }

  /**
   * Operation request
   */
  public async requestOperation(input: RequestOperationInput): Promise<OperationResponseOutput> {
    if (!input.operationDetails) {
      throw this.sendInternalError('Operation details must be provided')
    }
    if (!this.activeAccount) {
      throw this.sendInternalError('No active account!')
    }

    const activeAccount = this.activeAccount

    const request: OperationRequestInput = {
      type: BeaconMessageType.OperationRequest,
      network: input.network || activeAccount.network || { type: NetworkType.MAINNET },
      operationDetails: input.operationDetails,
      sourceAddress: activeAccount.address || ''
    }

    const { message, connectionInfo } = await this.makeRequest<OperationRequest, OperationResponse>(
      request
    ).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })

    const { beaconId, transactionHash } = message

    const output: OperationResponseOutput = { beaconId, transactionHash }

    await this.notifySuccess(request, {
      account: activeAccount,
      output,
      connectionContext: connectionInfo
    })

    return { beaconId, transactionHash }
  }

  /**
   * Broadcast request
   */
  public async requestBroadcast(input: RequestBroadcastInput): Promise<BroadcastResponseOutput> {
    if (!input.signedTransaction) {
      throw this.sendInternalError('Signed transaction must be provided')
    }

    const network = input.network || { type: NetworkType.MAINNET }

    const request: BroadcastRequestInput = {
      type: BeaconMessageType.BroadcastRequest,
      network,
      signedTransaction: input.signedTransaction
    }

    const { message, connectionInfo } = await this.makeRequest<BroadcastRequest, BroadcastResponse>(
      request
    ).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })

    const { beaconId, transactionHash } = message

    const output: BroadcastResponseOutput = { beaconId, transactionHash }

    await this.notifySuccess(request, { network, output, connectionContext: connectionInfo })

    return { beaconId, transactionHash }
  }

  private async sendInternalError(errorMessage: string): Promise<void> {
    await this.events.emit(BeaconEvent.INTERNAL_ERROR, errorMessage)
    throw new Error(errorMessage)
  }

  private async removeAccountsForPeers(peersToRemove: P2PPairInfo[]): Promise<void> {
    const accounts = await this.accountManager.getAccounts()

    const peerIdsToRemove = peersToRemove.map((peer) => peer.publicKey)
    // Remove all accounts with origin of the specified peer
    const accountsToRemove = accounts.filter((account) =>
      peerIdsToRemove.includes(account.origin.id)
    )
    const accountIdentifiersToRemove = accountsToRemove.map(
      (accountInfo) => accountInfo.accountIdentifier
    )
    await this.accountManager.removeAccounts(accountIdentifiersToRemove)

    // Check if one of the accounts that was removed was the active account and if yes, set it to undefined
    if (this.activeAccount) {
      const activeAccount = this.activeAccount
      if (accountIdentifiersToRemove.includes(activeAccount.accountIdentifier)) {
        await this.setActiveAccount(undefined)
      }
    }
  }

  private async handleRequestError(
    request: BeaconRequestInputMessage,
    beaconError: BeaconErrorMessage
  ): Promise<void> {
    if (beaconError.errorType) {
      this.events
        .emit(messageEvents[request.type].error, beaconError)
        .catch((emitError) => console.warn(emitError))

      console.log('beacon error', beaconError.errorType)
      throw BeaconError.getError(beaconError.errorType)
    }

    console.error('requestError', beaconError)

    throw beaconError
  }

  private async notifySuccess(
    request: BeaconRequestInputMessage,
    response:
      | {
          account: AccountInfo
          output: PermissionResponseOutput
          connectionContext: ConnectionContext
        }
      | {
          account: AccountInfo
          output: OperationResponseOutput
          connectionContext: ConnectionContext
        }
      | {
          output: SignPayloadResponseOutput
          connectionContext: ConnectionContext
        }
      | {
          network: Network
          output: BroadcastResponseOutput
          connectionContext: ConnectionContext
        }
  ): Promise<void> {
    this.events
      .emit(messageEvents[request.type].success, response)
      .catch((emitError) => console.warn(emitError))
  }

  private async makeRequest<T extends BeaconRequestInputMessage, U extends BeaconMessage>(
    requestInput: Omit<T, IgnoredRequestInputProperties>,
    account?: AccountInfo
  ): Promise<{
    message: U
    connectionInfo: ConnectionContext
  }> {
    logger.log('makeRequest')
    await this.init()
    logger.log('makeRequest', 'after init')
    await this.connect()
    logger.log('makeRequest', 'after connecting')

    if (await this.addRequestAndCheckIfRateLimited()) {
      this.events
        .emit(BeaconEvent.LOCAL_RATE_LIMIT_REACHED)
        .catch((emitError) => console.warn(emitError))

      throw new Error('rate limit reached')
    }

    if (!(await this.checkPermissions(requestInput.type))) {
      this.events.emit(BeaconEvent.NO_PERMISSIONS).catch((emitError) => console.warn(emitError))

      throw new Error('No permissions to send this request to wallet!')
    }

    if (!this.beaconId) {
      throw this.sendInternalError('BeaconID not defined')
    }

    const request: Omit<T, IgnoredRequestInputProperties> &
      Pick<U, IgnoredRequestInputProperties> = {
      id: generateGUID(),
      version: BEACON_VERSION,
      beaconId: await this.beaconId,
      ...requestInput
    }

    const exposed = new ExposedPromise<
      { message: BeaconMessage; connectionInfo: ConnectionContext },
      BeaconErrorMessage
    >()

    this.addOpenRequest(request.id, exposed)

    const payload = await new Serializer().serialize(request)

    let origin: string | undefined
    if (account) {
      origin = account.origin.id
    }
    await (await this.transport).send(payload, origin)

    this.events
      .emit(messageEvents[requestInput.type].sent)
      .catch((emitError) => console.warn(emitError))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return exposed.promise as any // TODO: fix type
  }
}
