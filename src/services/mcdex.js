import { ethers } from 'ethers';
import { logger } from './logger';
import BigNumber from 'bignumber.js';
import fetch from 'isomorphic-fetch';

import {
  ReaderFactory,
  SymbolServiceFactory,
  LiquidityPoolFactory,
  InsufficientLiquidityError
} from '@mcdex/mai3.js';
import {
  DECIMALS,
  CHAIN_ID_TO_READER_ADDRESS,
  CHAIN_ID_SYMBOL_SERVICE_ADDRESS
} from '@mcdex/mai3.js';
import { PerpetualState, TradeFlag } from '@mcdex/mai3.js';
import {
  getLiquidityPool,
  getAccountStorage,
  computeAccount
} from '@mcdex/mai3.js';

const globalConfig =
  require('../services/configuration_manager').configManagerInstance;

const TRADE_EXPIRE_TIME = 86400;
const REFERER_ADDRESS = '0x0000000000000000000000000000000000000000';
export default class mcdex {
  constructor(network = 'mainnet') {
    this.providerUrl = globalConfig.getConfig('ETHEREUM_RPC_URL');
    this.network = network;
    this.tradeGasBase =
      globalConfig.getConfig('MCDEX_TRADE_GAS_BASE') || 4800000;
    this.tradeGasPerPerpetual =
      globalConfig.getConfig('MCDEX_TRADE_GAS_PER_PERPETUAL') || 7300;
    this.provider = new ethers.providers.JsonRpcProvider(this.providerUrl);
    this.subgraphUrl = globalConfig.getConfig('MCDEX_SUBGRAPH_URL');
    if (!this.subgraphUrl) {
      const err = `mcdex.subgraphUrl is empty. part of this service will not work.`;
      logger.warn(err);
    }

    switch (network) {
      case 'mainnet':
        this.chainID = 1;
        break;
      case 'kovan':
        this.chainID = 42;
        break;
      case 'arb':
        this.chainID = 42161;
        break;
      case 'arbtest':
        this.chainID = 421611;
        break;
      default:
        const err = `Invalid network ${network}`;
        logger.error(err);
        throw Error(err);
    }

    this.reader = CHAIN_ID_TO_READER_ADDRESS[this.chainID];
    if (typeof this.reader === 'undefined') {
      const err = `Invalid network ${network}`;
      logger.error(err);
      throw Error(err);
    }

    this.symbolService = CHAIN_ID_SYMBOL_SERVICE_ADDRESS[this.chainID];
    if (typeof this.symbolService === 'undefined') {
      const err = `Invalid network ${network}`;
      logger.error(err);
      throw Error(err);
    }
  }

  async readGraphQL(query, variables) {
    const fetched = await fetch(this.subgraphUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: query,
        variables: variables
      }),
      timeout: 30000
    });
    const response = await fetched.json();
    if (
      response.errors &&
      response.errors.length > 0 &&
      response.errors[0].message
    ) {
      throw new Error(response.errors[0].message);
    }
    return response.data;
  }

  async queryPerpetualBySymbol(symbol) {
    const symbolService = SymbolServiceFactory.connect(
      this.symbolService,
      this.provider
    );
    const uid = await symbolService.getPerpetualUID(symbol);
    return {
      liquidityPoolAddress: uid.liquidityPool,
      perpetualIndex: uid.perpetualIndex.toNumber()
    };
  }

  async queryAllSymbols() {
    const graphResult = await this.readGraphQL(`
      {
        perpetuals {
          symbol
        }
      }
      `);
    return graphResult.perpetuals.map((i) => i.symbol);
  }

  async getPerpetual(liquidityPoolAddress, perpetualIndex) {
    const reader = ReaderFactory.connect(this.reader, this.provider);
    const liquidityPoolStorage = await getLiquidityPool(
      reader,
      liquidityPoolAddress
    );
    const perpetual = liquidityPoolStorage.perpetuals.get(perpetualIndex);
    if (typeof perpetual === 'undefined') {
      const err = `PerpetualIndex is out of bounds`;
      logger.error(err);
      throw Error(err);
    }
    return {
      liquidityPoolAddress,
      perpetualIndex,
      collateralAddress: liquidityPoolStorage.collateral,
      isTradable:
        liquidityPoolStorage.isSynced &&
        liquidityPoolStorage.isRunning &&
        perpetual.state === PerpetualState.NORMAL &&
        !perpetual.isMarketClosed,
      underlyingSymbol: perpetual.underlyingSymbol,
      indexPrice: perpetual.indexPrice.toFixed(),
      markPrice: perpetual.markPrice.toFixed(),
      fundingRate: perpetual.fundingRate.toFixed(),
      unitAccumulativeFunding: perpetual.unitAccumulativeFunding.toFixed(),
      vaultFeeRate: liquidityPoolStorage.vaultFeeRate.toFixed(),
      operatorFeeRate: perpetual.operatorFeeRate.toFixed(),
      lpFeeRate: perpetual.lpFeeRate.toFixed(),
      perpetualCountInLiquidityPool: liquidityPoolStorage.perpetuals.size
    };
  }

  async getAccount(wallet, liquidityPoolAddress, perpetualIndex) {
    const traderAddress = wallet.address;
    const reader = ReaderFactory.connect(this.reader, this.provider);
    // pool storage and account storage
    const [liquidityPoolStorage, accountStorage] = await Promise.all([
      await getLiquidityPool(reader, liquidityPoolAddress),
      await getAccountStorage(
        reader,
        liquidityPoolAddress,
        perpetualIndex,
        traderAddress
      )
    ]);
    // GraphQL is optional
    try {
      const graphResult = await this.readGraphQL(
        `
        query ($userAddr: ID!, $perpID: ID!) {
          marginAccounts(where: {
           user: $userAddr,
           perpetual: $perpID
         }) {
           id
           user { id }
             position
             entryValue
             entryFunding
           }
        }`,
        {
          userAddr: traderAddress.toLowerCase(),
          perpID:
            liquidityPoolAddress.toLowerCase() + '-' + perpetualIndex.toString()
        }
      );
      if (graphResult.marginAccounts && graphResult.marginAccounts.length > 0) {
        const graphMarginAccount = graphResult.marginAccounts[0];
        if (accountStorage.positionAmount.eq(graphMarginAccount.position)) {
          accountStorage.entryValue = new BigNumber(
            graphMarginAccount.entryValue
          );
          accountStorage.entryFunding = new BigNumber(
            graphMarginAccount.entryFunding
          );
        }
      }
    } catch (e) {
      const err = `mcdex.graphQL failed, ignored: ${e.toString()}`;
      logger.warn(err);
    }
    const computed = computeAccount(
      liquidityPoolStorage,
      perpetualIndex,
      accountStorage
    );
    return {
      liquidityPoolAddress,
      perpetualIndex,
      traderAddress,
      position: accountStorage.positionAmount.toFixed(),
      marginBalance: computed.accountComputed.marginBalance.toFixed(),
      availableMargin: computed.accountComputed.availableMargin.toFixed(),
      liquidationPrice: computed.accountComputed.liquidationPrice.toFixed(),
      availableCashBalance:
        computed.accountComputed.availableCashBalance.toFixed(),
      entryPrice: computed.accountComputed.entryPrice
        ? computed.accountComputed.entryPrice.toFixed()
        : null,
      fundingPNL: computed.accountComputed.fundingPNL
        ? computed.accountComputed.fundingPNL.toFixed()
        : null,
      pnl: computed.accountComputed.pnl2
        ? computed.accountComputed.pnl2.toFixed()
        : null
    };
  }

  async getPrice(
    liquidityPoolAddress,
    perpetualIndex,
    amount,
    trader,
    isCloseOnly
  ) {
    const bigAmount = new BigNumber(amount.toString())
      .shiftedBy(DECIMALS)
      .dp(0);
    const reader = ReaderFactory.connect(this.reader, this.provider);
    let flags = TradeFlag.MASK_USE_TARGET_LEVERAGE;
    if (isCloseOnly) {
      flags = flags + TradeFlag.MASK_CLOSE_ONLY; // do NOT use "|=" to prevent js error
    }
    try {
      const { isSynced, tradePrice, totalFee, cost } =
        await reader.callStatic.queryTrade(
          liquidityPoolAddress,
          perpetualIndex,
          trader,
          bigAmount.toFixed(),
          REFERER_ADDRESS,
          flags
        );
      if (!isSynced) {
        throw new Error('sync perpetual storage failed');
      }
      return {
        price: new BigNumber(tradePrice.toString()).shiftedBy(-DECIMALS),
        totalFee: new BigNumber(totalFee.toString()).shiftedBy(-DECIMALS),
        cost: new BigNumber(cost.toString()).shiftedBy(-DECIMALS)
      };
    } catch (err) {
      // find "trade amount exceeds max amount"
      if (
        err.error &&
        err.error.data &&
        err.error.data.indexOf('65786365656473') > 0
      ) {
        throw new InsufficientLiquidityError('InsufficientLiquidityError');
      }
      throw err;
    }
  }

  async trade(
    wallet,
    liquidityPoolAddress,
    perpetualIndex,
    amount,
    limitPrice,
    isCloseOnly,
    gasPrice,
    gasLimit
  ) {
    const traderAddress = await wallet.getAddress();
    const bigAmount = new BigNumber(amount.toString())
      .shiftedBy(DECIMALS)
      .dp(0);
    const bigLimitPrice = new BigNumber(limitPrice.toString())
      .shiftedBy(DECIMALS)
      .dp(0);
    const deadline = Math.ceil(new Date() / 1000) + TRADE_EXPIRE_TIME;
    let flags = TradeFlag.MASK_USE_TARGET_LEVERAGE;
    if (isCloseOnly) {
      flags = flags + TradeFlag.MASK_CLOSE_ONLY; // do NOT use "|=" to prevent js error
    }
    const liquidityPool = LiquidityPoolFactory.connect(
      liquidityPoolAddress,
      wallet
    );
    const tx = await liquidityPool.trade(
      perpetualIndex,
      traderAddress,
      bigAmount.toFixed(),
      bigLimitPrice.toFixed(),
      deadline,
      REFERER_ADDRESS,
      flags,
      {
        gasPrice: gasPrice * 1e9,
        gasLimit
      }
    );
    return tx;
  }

  estimateTradeGasLimit(perpetualCountInLiquidityPool) {
    if (!perpetualCountInLiquidityPool) {
      throw new Error('can not fetch perpetualCountInLiquidityPool');
    }
    const gasLimit =
      this.tradeGasBase +
      perpetualCountInLiquidityPool * this.tradeGasPerPerpetual;
    return gasLimit;
  }
}
