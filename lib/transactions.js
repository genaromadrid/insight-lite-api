'use strict';

var config = require('config');
var bitcore = require(config.bitcoinLib);
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Common = require('./common');
var async = require('async');
var CCParser = require('./cc_parser');
var CCTransaction = require('./models/cc_transaction');
var lodash = require('lodash');
var MAXINT = 0xffffffff; // Math.pow(2, 32) - 1;

function TxController(node) {
  this.node = node;
  this.common = new Common({
    log: this.node.log
  });
  this.ccParser = new CCParser(this.node);
}

TxController.prototype.show = function (req, res) {
  if (req.transaction) {
    res.jsonp(req.transaction);
  }
};
/**
 * Find transaction by hash ...
 */
TxController.prototype.transaction = function (req, res, next) {
  const txid = req.params.txid;
  this._transaction(txid).then((transformedTransaction) => {
    req.transaction = transformedTransaction;
    next();
  }).catch(() => {
    this.common.handleErrors(null, res);
  });
};

TxController.prototype._transaction = function (txid) {
  var self = this;
  return new Promise((resolve, reject) => {
    this.node.getDetailedTransaction(txid, (err, transaction) => {
      if (err && err.code === -5) {
        reject(err);
      }
      this.transformTransaction(transaction, (err, transformedTransaction) => {
        if (err) {
          reject(err);
          return;
        }
        self._proccessTransformTransaction(transformedTransaction, (err, transformedTx) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(transformedTx)
        });
      })
    });
  });
};

TxController.prototype.checkAndStoreCCTransaction = function (txid, callback) {
  var self = this;
  this.getTransformTransaction(txid, function (err, rootTransformedTx) {
    if (err) {
      callback(err, null);
    }
    if (rootTransformedTx == undefined) {
      self.node.log.error(`Transaction not found ${txid}`);
      callback(null, false);
      return
    }
    self._proccessTransformTransaction(rootTransformedTx, (err, transformedTx) => {
      var ccData = self.ccParser.parseTransaction(transformedTx);
      if (ccData.length > 0) {
        self.storeCCTransaction(transformedTx, ccData, callback);
      } else {
        callback(null, false);
      }
    });
  });
};

TxController.prototype._proccessTransformTransaction = function (rootTransformedTx, callback) {
  var self = this;
  self._evaluateTransformTransaction(rootTransformedTx).then((results) => {
    var transformedTx = {};
    if (results.isIssuanceTx === true) {
      rootTransformedTx.assets[0].assetId = results.transformedTx.assets[0].assetId;
      transformedTx = rootTransformedTx;
    } else {
      transformedTx = results.transformedTx;
    }
    callback(null, transformedTx);
  }).catch((err) => {
    callback(err);
  })
};

TxController.prototype._evaluateTransformTransaction = function (transformedTx) {
  var self = this;
  var results = {
    isIssuanceTx: false,
    transformedTx: transformedTx
  }
  return new Promise((resolve, reject) => {
    if (transformedTx.assets.length == 0) {
      resolve(results);
    } else {
      var type = transformedTx.assets[0].type;
      if (type === 'issuance') {
        resolve(results);
      }
      self._searchIssuanceTx(transformedTx).then((txid) => {
        self.getTransformTransaction(txid, function (err, transformedTx) {
          if (err) {
            reject(err);
          }
          self._evaluateTransformTransaction(transformedTx).then((container) => {
            results.transformedTx = container.transformedTx;
            results.isIssuanceTx = true;
            resolve(results);
          })
        })
      })
    }
  });
};

TxController.prototype._searchIssuanceTx = function (transformedTx) {
  var self = this;
  return new Promise((resolve, reject) => {
    lodash.forEach(transformedTx.vin, function (input) {
      self._isIssuanceTx(input).then((results) => {
        if (results.isIssuanceTx === true) {
          resolve(results.issueanceTx.hash)
        }
      })
    });
  });
};

TxController.prototype._isIssuanceTx = function (input) {
  var self = this;
  return new Promise((resolve, reject) => {
    self.node.getDetailedTransaction(input.txid, function (err, input_tx) {
      if (err) {
        reject(err);
      }
      var results = {
        isIssuanceTx: false,
        issueanceTx: input_tx
      }
      if (input_tx !== undefined && input_tx.outputs !== undefined) {
        results.isIssuanceTx = lodash.some(input_tx.outputs, function (out) {
          return out.scriptAsm.includes('OP_RETURN ');
        });
      }
      resolve(results);
    });
  });
};
/*
 * Save ColoredCoins transaction in DB
 */
TxController.prototype.storeCCTransaction = function (tx, ccData, callback) {
  var self = this;
  ccData.forEach(function (data) {
    var payments = [];
    var addresses = [];
    if (data.payments !== undefined) {
      data.payments.forEach(function (item) {
        var payment = JSON.parse(JSON.stringify(item));
        var output = tx.vout[payment.output];
        if (output.scriptPubKey !== undefined) {
          var address = output.scriptPubKey.addresses;
          payment.address = address;
          addresses.push(address);
        }
        payments.push(payment);
      });
    }
    data.payments = payments;
    var transaction = new CCTransaction(data);
    if (!lodash.contains(addresses, tx.vin[0].address)) {
      addresses.push(tx.vin[0].address);
    }
    transaction.hash = tx.txid;
    transaction.addresses = addresses;
    transaction.timestamp = new Date(tx.time * 1000)
    transaction.save(function (err, cctransaction) {
      if (err) {
        callback(err)
        self.node.log.error(err.message);
        return
      }
      self.node.log.info(`Saved asset ${cctransaction.assetId} in transaction ${tx.txid}`)
      callback(null, cctransaction)
    });
  });
};

TxController.prototype.getTransformTransaction = function (txid, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  $.checkArgument(_.isFunction(callback));
  var self = this;
  this.node.getDetailedTransaction(txid, function (err, transaction) {
    if (err) {
      callback(err)
      self.node.log.error(err)
      return
    }
    self.transformTransaction(transaction, options, callback);
  });
}

TxController.prototype.transformTransaction = function (transaction, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  $.checkArgument(_.isFunction(callback));
  if (transaction == undefined) {
    callback({
      message: 'Transaction not found'
    }, null);
    return;
  }
  var confirmations = 0;
  if (transaction.height >= 0) {
    confirmations = this.node.services.bitcoind.height - transaction.height + 1;
  }
  var transformed = {
    txid: transaction.hash,
    version: transaction.version,
    locktime: transaction.locktime
  };
  if (transaction.coinbase) {
    transformed.vin = [{
      coinbase: transaction.inputs[0].script,
      sequence: transaction.inputs[0].sequence,
      n: 0
    }];
  } else {
    transformed.vin = transaction.inputs.map(this.transformInput.bind(this, options));
  }
  transformed.vout = transaction.outputs.map(this.transformOutput.bind(this, options));
  transformed.blockhash = transaction.blockHash;
  transformed.blockheight = transaction.height;
  transformed.confirmations = confirmations;
  // TODO consider mempool txs with receivedTime?
  var time = transaction.blockTimestamp ? transaction.blockTimestamp : Math.round(Date.now() / 1000);
  transformed.time = time;
  if (transformed.confirmations) {
    transformed.blocktime = transformed.time;
  }
  if (transaction.coinbase) {
    transformed.isCoinBase = true;
  }
  transformed.valueOut = transaction.outputSatoshis / 1e8;
  transformed.size = transaction.hex.length / 2; // in bytes
  if (!transaction.coinbase) {
    transformed.valueIn = transaction.inputSatoshis / 1e8;
    transformed.fees = transaction.feeSatoshis / 1e8;
  }
  var ccData = this.ccParser.parseTransaction(transformed);
  transformed.assets = ccData;
  callback(null, transformed);
};

TxController.prototype.transformInput = function (options, input, index) {
  // Input scripts are validated and can be assumed to be valid
  var transformed = {
    txid: input.prevTxId,
    vout: input.outputIndex,
    sequence: input.sequence,
    n: index
  };
  if (!options.noScriptSig) {
    transformed.scriptSig = {
      hex: input.script
    };
    if (!options.noAsm) {
      transformed.scriptSig.asm = input.scriptAsm;
    }
  }
  transformed.address = input.address;
  transformed.valueSat = input.satoshis;
  transformed.value = input.satoshis / 1e8;
  transformed.doubleSpentTxID = null; // TODO
  //transformed.isConfirmed = null; // TODO
  //transformed.confirmations = null; // TODO
  //transformed.unconfirmedInput = null; // TODO
  return transformed;
};

TxController.prototype.transformOutput = function (options, output, index) {
  var transformed = {
    value: (output.satoshis / 1e8).toFixed(8),
    n: index,
    scriptPubKey: {
      hex: output.script
    }
  };
  if (!options.noAsm) {
    transformed.scriptPubKey.asm = output.scriptAsm;
  }
  if (!options.noSpent) {
    transformed.spentTxId = output.spentTxId || null;
    transformed.spentIndex = _.isUndefined(output.spentIndex) ? null : output.spentIndex;
    transformed.spentHeight = output.spentHeight || null;
  }
  if (output.address) {
    transformed.scriptPubKey.addresses = [output.address];
    var address = bitcore.Address(output.address); //TODO return type from bitcore-node
    transformed.scriptPubKey.type = address.type;
  }
  return transformed;
};

TxController.prototype.transformInvTransaction = function (transaction) {
  var self = this;
  var valueOut = 0;
  var vout = [];
  for (var i = 0; i < transaction.outputs.length; i++) {
    var output = transaction.outputs[i];
    valueOut += output.satoshis;
    if (output.script) {
      var address = output.script.toAddress(self.node.network);
      if (address) {
        var obj = {};
        obj[address.toString()] = output.satoshis;
        vout.push(obj);
      }
    }
  }
  var isRBF = _.any(_.pluck(transaction.inputs, 'sequenceNumber'), function (seq) {
    return seq < MAXINT - 1;
  });
  var transformed = {
    txid: transaction.hash,
    valueOut: valueOut / 1e8,
    vout: vout,
    isRBF: isRBF,
  };
  return transformed;
};

TxController.prototype.rawTransaction = function (req, res, next) {
  var self = this;
  var txid = req.params.txid;
  this.node.getTransaction(txid, function (err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if (err) {
      return self.common.handleErrors(err, res);
    }
    req.rawTransaction = {
      'rawtx': transaction.toBuffer().toString('hex')
    };
    next();
  });
};
TxController.prototype.showRaw = function (req, res) {
  if (req.rawTransaction) {
    res.jsonp(req.rawTransaction);
  }
};
TxController.prototype.list = function (req, res) {
  var self = this;
  var blockHash = req.query.block;
  var address = req.query.address;
  var page = parseInt(req.query.pageNum) || 0;
  var pageLength = 10;
  var pagesTotal = 1;
  if (blockHash) {
    self.node.getBlockOverview(blockHash, function (err, block) {
      if (err && err.code === -5) {
        return self.common.handleErrors(null, res);
      } else if (err) {
        return self.common.handleErrors(err, res);
      }
      var totalTxs = block.txids.length;
      var txids;
      if (!_.isUndefined(page)) {
        var start = page * pageLength;
        txids = block.txids.slice(start, start + pageLength);
        pagesTotal = Math.ceil(totalTxs / pageLength);
      } else {
        txids = block.txids;
      }
      async.mapSeries(txids, function (txid, next) {
        self.node.getDetailedTransaction(txid, function (err, transaction) {
          if (err) {
            return next(err);
          }
          self.transformTransaction(transaction, next);
        });
      }, function (err, transformed) {
        if (err) {
          return self.common.handleErrors(err, res);
        }
        res.jsonp({
          pagesTotal: pagesTotal,
          txs: transformed
        });
      });
    });
  } else if (address) {
    var options = {
      from: page * pageLength,
      to: (page + 1) * pageLength
    };
    self.node.getAddressHistory(address, options, function (err, result) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      var txs = result.items.map(function (info) {
        return info.tx;
      }).filter(function (value, index, self) {
        return self.indexOf(value) === index;
      });
      async.map(txs, function (tx, next) {
        self.transformTransaction(tx, next);
      }, function (err, transformed) {
        if (err) {
          return self.common.handleErrors(err, res);
        }
        res.jsonp({
          pagesTotal: Math.ceil(result.totalCount / pageLength),
          txs: transformed
        });
      });
    });
  } else {
    return self.common.handleErrors(new Error('Block hash or address expected'), res);
  }
};
TxController.prototype.send = function (req, res) {
  var self = this;
  if (!req.body.txHex) {
    return self.common.handleErrors(new Error('"txHex" is required for sending an asset'), res);
  }
  this.node.sendTransaction(req.body.txHex, function (err, txid) {
    if (err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }
    res.json({
      'txid': txid
    });
  });
};
module.exports = TxController;
