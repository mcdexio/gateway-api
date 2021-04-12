import { ethers } from 'ethers';
import express from 'express';

import { getParamData, latency, statusMessages } from '../services/utils';
import { logger } from '../services/logger';
import MCDEX from '../services/mcdex';
import Fees from '../services/fees';

require('dotenv').config()

const router = express.Router()
const mcdex = new MCDEX(process.env.ETHEREUM_CHAIN)
const fees = new Fees()

router.post('/', async (req, res) => {
  /*
    POST /
  */
  res.status(200).json({
    network: mcdex.network,
    provider: mcdex.provider.connection.url,
    mcdex_reader: mcdex.reader,
    mcdex_symbol_service: mcdex.symbolService,
    mcdex_subgraph: mcdex.subgraphUrl,
    connection: true,
    timestamp: Date.now(),
  });
})

router.get('/symbols', async (req, res) => {
  /*
      GET: /symbols
  */
  const initTime = Date.now();
  try {
    const symbols = await mcdex.queryAllSymbols();
    logger.info('mcdex.route - symbols');
    res.status(200).json({
      network: mcdex.network,
      timestamp: initTime,
      latency: latency(initTime, Date.now()),
      symbols,
    });
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    let reason;
    err.reason ? reason = err.reason : reason = "Read symbols failed";
    res.status(500).json({
      error: reason,
      message: err
    });
  }
})

const getPerpetualInfoBySymbol = async function (symbol) {
  if (!symbol) {
    throw Error('missing "symbol"');
  }
  const uid = await mcdex.queryPerpetualBySymbol(symbol);
  const liquidityPoolAddress = uid.liquidityPoolAddress;
  const perpetualIndex = uid.perpetualIndex;
  const perpetual = await mcdex.getPerpetual(liquidityPoolAddress, perpetualIndex);
  return perpetual;
}

router.get('/perpetual', async (req, res) => {
  /*
    GET: /perpetual?symbol={{symbol}} // ex: 00001
  */
  const initTime = Date.now();
  const symbol = req.query.symbol;
  try {
    const perpetual = await getPerpetualInfoBySymbol(symbol);
    logger.info('mcdex.route - perpetual', { symbol });
    res.status(200).json({
      network: mcdex.network,
      timestamp: initTime,
      latency: latency(initTime, Date.now()),
      perpetual,
    });
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = "Symbol not found or read LiquidityPool failed";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
  }
})

router.post('/account', async (req, res) => {
  /*
    POST: /account
    x-www-form-urlencoded: {
      privateKey: {{privateKey}}
      symbol: {{symbol}}, // ex: 00001
    }
  */
  const initTime = Date.now();
  const paramData = getParamData(req.body);
  const privateKey = paramData.privateKey;
  const symbol = paramData.symbol;
  let wallet;
  try {
    wallet = new ethers.Wallet(privateKey, mcdex.provider);
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = err.reason ? err.reason : "Error getting wallet";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
    return;
  }
  let perpetual;
  try {
    perpetual = await getPerpetualInfoBySymbol(symbol);
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = "Symbol not found or read LiquidityPool failed";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
  }
  try {
    const account = await mcdex.getAccount(wallet, perpetual.liquidityPoolAddress, perpetual.perpetualIndex);
    logger.info('mcdex.route - account', { symbol });
    res.status(200).json({
      network: mcdex.network,
      timestamp: initTime,
      latency: latency(initTime, Date.now()),
      account,
    });
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = err.reason ? err.reason : "Read AccountStorage failed";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
  }
})

router.get('/price', async (req, res) => {
  /*
    GET: /price?symbol={{symbol}} // ex: 00001
               &amount={{amount}} // < 0 means sell
  */
 const initTime = Date.now();
 const symbol = req.query.symbol;
 const amount = req.query.amount;
 let perpetual;
 try {
   perpetual = await getPerpetualInfoBySymbol(symbol);
 } catch (err) {
   logger.error(req.originalUrl, { message: err });
   const reason = "Symbol not found or read LiquidityPool failed";
   const message = err.message ? err.message : err;
   res.status(500).json({
     error: reason,
     message,
   });
 }
 try {
   if (!amount || amount === '0') {
     throw Error('invalid "amount"');
   }
   const price = await mcdex.getPrice(perpetual.liquidityPoolAddress, perpetual.perpetualIndex, amount);
   logger.info('mcdex.route - price', { symbol, amount });
   res.status(200).json({
     network: mcdex.network,
     timestamp: initTime,
     latency: latency(initTime, Date.now()),
     price,
   });
 } catch (err) {
   logger.error(req.originalUrl, { message: err });
   const reason = err.reason ? err.reason : "Query price failed";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
 }
})

router.post('/trade', async (req, res) => {
  /*
    POST: /trade
    x-www-form-urlencoded: {
      privateKey: {{privateKey}}
      symbol: {{symbol}}, // ex: 00001
      amount: {{amount}}, // < 0 means sell
      limitPrice: {{limitPrice}},
      isCloseOnly: false // true | false,
      gasPrice: 100 | undefined
    }
  */
  const initTime = Date.now();
  const paramData = getParamData(req.body);
  const privateKey = paramData.privateKey;
  const symbol = paramData.symbol;
  const amount = paramData.amount;
  const limitPrice = paramData.limitPrice;
  const isCloseOnly = paramData.isCloseOnly === 'true';
  let gasPrice
  if (paramData.gasPrice) {
    gasPrice = parseFloat(paramData.gasPrice)
  } else {
    gasPrice = fees.ethGasPrice
  }
  let wallet;
  try {
    wallet = new ethers.Wallet(privateKey, mcdex.provider);
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = err.reason ? err.reason : "Error getting wallet";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
    return;
  }
  let perpetual;
  try {
    perpetual = await getPerpetualInfoBySymbol(symbol);
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = "Symbol not found or read LiquidityPool failed";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
  }
  let gasLimit = mcdex.estimateTradeGasLimit(perpetual.perpetualCountInLiquidityPool);
  try {
    if (!amount || amount === '0') {
     throw Error('invalid "amount"');
    }
    const tx = await mcdex.trade(
      wallet, perpetual.liquidityPoolAddress, perpetual.perpetualIndex, amount,
      limitPrice, isCloseOnly, gasPrice, gasLimit);
    logger.info('mcdex.route - trade', { symbol });
    res.status(200).json({
      network: mcdex.network,
      timestamp: initTime,
      latency: latency(initTime, Date.now()),
      txHash: tx.hash,
    });
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = err.reason ? err.reason : "Trade failed";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
  }
})

router.get('/receipt', async (req, res) => {
  /*
    GET: /receipt?txHash={{txHash}}
  */
  const initTime = Date.now()
  const txHash = req.query.txHash
  try {
    const txReceipt = await mcdex.provider.getTransactionReceipt(txHash)
    const receipt = {}
    const confirmed = txReceipt && txReceipt.blockNumber ? true : false
    if (txReceipt !== null) {
      receipt.gasUsed = ethers.utils.formatEther(txReceipt.gasUsed)
      receipt.blockNumber = txReceipt.blockNumber
      receipt.confirmations = txReceipt.confirmations
      receipt.status = txReceipt.status
    }
    logger.info(`mcdex.route - receipt: ${txHash}`, { message: JSON.stringify(receipt) })
    res.status(200).json({
      network: mcdex.network,
      timestamp: initTime,
      latency: latency(initTime, Date.now()),
      txHash: txHash,
      confirmed: confirmed,
      receipt: receipt,
    })
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    const reason = err.reason ? err.reason : "Get receipt failed";
    const message = err.message ? err.message : err;
    res.status(500).json({
      error: reason,
      message,
    });
  }
})

export default router;
