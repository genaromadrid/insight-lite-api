var mongoose = require('mongoose');

// Columns:
//   - hash
//   - assetId
//   - address
//   - payments
//   - protocol
//   - version
//   - type
//   - lockStatus
//   - aggregationPolicy
//   - divisibility
//   - amount
//   - multiSig

const Schema = mongoose.Schema;
const CCTransaction = new Schema({
  hash: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    required: true
  },
  assetId: {
    type: String,
    required: false
  },
  addresses: {
    type: Array,
    required: true
  },
  payments: {
    type: Array,
    required: false
  },
  protocol: {
    type: Number,
    required: true
  },
  version: {
    type: Number,
    required: true
  },
  type: {
    type: String,
    required: true
  },
  lockStatus: {
    type: Boolean,
    required: false
  },
  aggregationPolicy: {
    type: String,
    required: false
  },
  divisibility: {
    type: Number,
    required: false
  },
  amount: {
    type: Number,
    required: false
  },
  multiSig: {
    type: Array,
    required: false
  }
}, {
    timestamps: {
      createdAt: 'created_at'
    },
    toObject: {
      getters: true
    }
  });

CCTransaction.virtual('timestamp_ms').get(function() {
  return this.timestamp.getTime();
});

module.exports = mongoose.model('CCTransaction', CCTransaction);
