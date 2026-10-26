// 由 scripts/gen-abis.ts 生成自 artifacts/contracts/core/interfaces/IPoolV1.sol/IPoolV1.json,勿手改
export const poolAbi = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "int24",
        "name": "tickLower",
        "type": "int24"
      },
      {
        "indexed": true,
        "internalType": "int24",
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount0",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "name": "Burn",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "int24",
        "name": "tickLower",
        "type": "int24"
      },
      {
        "indexed": true,
        "internalType": "int24",
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount0",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount1",
        "type": "uint128"
      }
    ],
    "name": "Collect",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "sender",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount0",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount1",
        "type": "uint128"
      }
    ],
    "name": "CollectProtocol",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "status",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "p0X96",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "pIndexX96",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "feeBase",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "tradeSize",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "quoteValueOfBase",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "quoteBalance",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "isBuyingBase",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "arbitrageFee",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "tradeSlippageFee",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "imbalanceFee",
        "type": "uint24"
      }
    ],
    "name": "DynamicFee",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "sender",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint8",
        "name": "feeClass",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "zeroForOne",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "feeAmount",
        "type": "uint256"
      }
    ],
    "name": "ExtraTradeFee",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "sender",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount0",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount1",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "paid0",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "paid1",
        "type": "uint256"
      }
    ],
    "name": "Flash",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "observationCardinalityNextOld",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "observationCardinalityNextNew",
        "type": "uint16"
      }
    ],
    "name": "IncreaseObservationCardinalityNext",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "sender",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "int24",
        "name": "tickLower",
        "type": "int24"
      },
      {
        "indexed": true,
        "internalType": "int24",
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount0",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "name": "Mint",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "flags",
        "type": "uint8"
      }
    ],
    "name": "Paused",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "oldRate",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "newRate",
        "type": "uint24"
      }
    ],
    "name": "SetAlphaExtraTradeFeeRate",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "oldRate",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "newRate",
        "type": "uint24"
      }
    ],
    "name": "SetDexExtraTradeFeeRate",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bool",
        "name": "oldEnabled",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "newEnabled",
        "type": "bool"
      }
    ],
    "name": "SetDynamicFeeEnabled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "feed0",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "feed1",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "isToken1Quote",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "pow10",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "negExp",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "quoteUnit",
        "type": "uint64"
      }
    ],
    "name": "SetDynamicFeeOracle",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "bufferPpm",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "slipBase",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "slipThreshold",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "imbBase",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "imbX",
        "type": "uint8"
      }
    ],
    "name": "SetDynamicFeeParams",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "oldMax",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "newMax",
        "type": "uint24"
      }
    ],
    "name": "SetMaxDynamicFeeRate",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "oldProtocolFeeRate",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "newProtocolFeeRate",
        "type": "uint8"
      }
    ],
    "name": "SetProtocolFeeRate",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "oldTradeFeeRate",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "uint24",
        "name": "newTradeFeeRate",
        "type": "uint24"
      }
    ],
    "name": "SetTradeFeeRate",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "sender",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "amount0",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "amount1",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "uint160",
        "name": "sqrtPriceX96",
        "type": "uint160"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "int24",
        "name": "tick",
        "type": "int24"
      }
    ],
    "name": "Swap",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "flags",
        "type": "uint8"
      }
    ],
    "name": "Unpaused",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "alphaExtraTradeFeeRate",
    "outputs": [
      {
        "internalType": "uint24",
        "name": "",
        "type": "uint24"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "int24",
        "name": "tickLower",
        "type": "int24"
      },
      {
        "internalType": "int24",
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "internalType": "uint128",
        "name": "amount",
        "type": "uint128"
      }
    ],
    "name": "burn",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "amount0",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "internalType": "int24",
        "name": "tickLower",
        "type": "int24"
      },
      {
        "internalType": "int24",
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "internalType": "uint128",
        "name": "amount0Requested",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "amount1Requested",
        "type": "uint128"
      }
    ],
    "name": "collect",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "amount0",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "amount1",
        "type": "uint128"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint128",
        "name": "amount0Requested",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "amount1Requested",
        "type": "uint128"
      }
    ],
    "name": "collectProtocol",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "amount0",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "amount1",
        "type": "uint128"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dexExtraTradeFeeRate",
    "outputs": [
      {
        "internalType": "uint24",
        "name": "",
        "type": "uint24"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeArbitrageBufferPpm",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeEnabled",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeFeed0",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeFeed1",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeImbalanceBase",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeImbalanceX",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeIsToken1Quote",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeNegExp",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeePow10",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeQuoteUnit",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeSlippageBase",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dynamicFeeSlippageThreshold",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "factory",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "feeGrowthGlobal0X128",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "feeGrowthGlobal1X128",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount0",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount1",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "flash",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "observationCardinalityNext",
        "type": "uint16"
      }
    ],
    "name": "increaseObservationCardinalityNext",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "factory_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "token0_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "token1_",
        "type": "address"
      },
      {
        "internalType": "int24",
        "name": "tickSpacing_",
        "type": "int24"
      },
      {
        "internalType": "address",
        "name": "protocolController_",
        "type": "address"
      },
      {
        "internalType": "uint24",
        "name": "initialTradeFeeRate",
        "type": "uint24"
      },
      {
        "internalType": "uint8",
        "name": "initialProtocolFeeRate",
        "type": "uint8"
      },
      {
        "internalType": "uint160",
        "name": "sqrtPriceX96",
        "type": "uint160"
      },
      {
        "internalType": "uint32",
        "name": "swapOpenTime",
        "type": "uint32"
      },
      {
        "internalType": "bytes",
        "name": "extra",
        "type": "bytes"
      }
    ],
    "name": "initializePool",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "liquidity",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "maxDynamicFeeRate",
    "outputs": [
      {
        "internalType": "uint24",
        "name": "",
        "type": "uint24"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "maxLiquidityPerTick",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "internalType": "int24",
        "name": "tickLower",
        "type": "int24"
      },
      {
        "internalType": "int24",
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "internalType": "uint128",
        "name": "amount",
        "type": "uint128"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "mint",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "amount0",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "index",
        "type": "uint256"
      }
    ],
    "name": "observations",
    "outputs": [
      {
        "internalType": "uint32",
        "name": "blockTimestamp",
        "type": "uint32"
      },
      {
        "internalType": "int56",
        "name": "tickCumulative",
        "type": "int56"
      },
      {
        "internalType": "uint160",
        "name": "secondsPerLiquidityCumulativeX128",
        "type": "uint160"
      },
      {
        "internalType": "bool",
        "name": "initialized",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint32[]",
        "name": "secondsAgos",
        "type": "uint32[]"
      }
    ],
    "name": "observe",
    "outputs": [
      {
        "internalType": "int56[]",
        "name": "tickCumulatives",
        "type": "int56[]"
      },
      {
        "internalType": "uint160[]",
        "name": "secondsPerLiquidityCumulativeX128s",
        "type": "uint160[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pauseFlags",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "key",
        "type": "bytes32"
      }
    ],
    "name": "positions",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "internalType": "uint256",
        "name": "feeGrowthInside0LastX128",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "feeGrowthInside1LastX128",
        "type": "uint256"
      },
      {
        "internalType": "uint128",
        "name": "tokensOwed0",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "tokensOwed1",
        "type": "uint128"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "protocolController",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "protocolFees",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "token0",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "token1",
        "type": "uint128"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint24",
        "name": "newRate",
        "type": "uint24"
      }
    ],
    "name": "setAlphaExtraTradeFeeRate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint24",
        "name": "newRate",
        "type": "uint24"
      }
    ],
    "name": "setDexExtraTradeFeeRate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bool",
        "name": "enabled",
        "type": "bool"
      }
    ],
    "name": "setDynamicFeeEnabled",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "feed0",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "feed1",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "isToken1Quote",
        "type": "bool"
      }
    ],
    "name": "setDynamicFeeOracle",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "bufferPpm",
        "type": "uint16"
      },
      {
        "internalType": "uint8",
        "name": "slipBase",
        "type": "uint8"
      },
      {
        "internalType": "uint8",
        "name": "slipThreshold",
        "type": "uint8"
      },
      {
        "internalType": "uint8",
        "name": "imbBase",
        "type": "uint8"
      },
      {
        "internalType": "uint8",
        "name": "imbX",
        "type": "uint8"
      }
    ],
    "name": "setDynamicFeeParams",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint24",
        "name": "newMax",
        "type": "uint24"
      }
    ],
    "name": "setMaxDynamicFeeRate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "newFlags",
        "type": "uint8"
      }
    ],
    "name": "setPauseFlags",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "newProtocolFeeRate",
        "type": "uint8"
      }
    ],
    "name": "setProtocolFeeRate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint24",
        "name": "newTradeFeeRate",
        "type": "uint24"
      }
    ],
    "name": "setTradeFeeRate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "slot0",
    "outputs": [
      {
        "internalType": "uint160",
        "name": "sqrtPriceX96",
        "type": "uint160"
      },
      {
        "internalType": "int24",
        "name": "tick",
        "type": "int24"
      },
      {
        "internalType": "uint16",
        "name": "observationIndex",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "observationCardinality",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "observationCardinalityNext",
        "type": "uint16"
      },
      {
        "internalType": "uint8",
        "name": "protocolFeeRate",
        "type": "uint8"
      },
      {
        "internalType": "bool",
        "name": "unlocked",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "int24",
        "name": "tickLower",
        "type": "int24"
      },
      {
        "internalType": "int24",
        "name": "tickUpper",
        "type": "int24"
      }
    ],
    "name": "snapshotCumulativesInside",
    "outputs": [
      {
        "internalType": "int56",
        "name": "tickCumulativeInside",
        "type": "int56"
      },
      {
        "internalType": "uint160",
        "name": "secondsPerLiquidityInsideX128",
        "type": "uint160"
      },
      {
        "internalType": "uint32",
        "name": "secondsInside",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "zeroForOne",
        "type": "bool"
      },
      {
        "internalType": "int256",
        "name": "amountSpecified",
        "type": "int256"
      },
      {
        "internalType": "uint160",
        "name": "sqrtPriceLimitX96",
        "type": "uint160"
      },
      {
        "internalType": "uint8",
        "name": "extraFeeClass",
        "type": "uint8"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "swap",
    "outputs": [
      {
        "internalType": "int256",
        "name": "amount0",
        "type": "int256"
      },
      {
        "internalType": "int256",
        "name": "amount1",
        "type": "int256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "swapOpenTime",
    "outputs": [
      {
        "internalType": "uint32",
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "int16",
        "name": "wordPosition",
        "type": "int16"
      }
    ],
    "name": "tickBitmap",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "tickSpacing",
    "outputs": [
      {
        "internalType": "int24",
        "name": "",
        "type": "int24"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "int24",
        "name": "tick",
        "type": "int24"
      }
    ],
    "name": "ticks",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "liquidityGross",
        "type": "uint128"
      },
      {
        "internalType": "int128",
        "name": "liquidityNet",
        "type": "int128"
      },
      {
        "internalType": "uint256",
        "name": "feeGrowthOutside0X128",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "feeGrowthOutside1X128",
        "type": "uint256"
      },
      {
        "internalType": "int56",
        "name": "tickCumulativeOutside",
        "type": "int56"
      },
      {
        "internalType": "uint160",
        "name": "secondsPerLiquidityOutsideX128",
        "type": "uint160"
      },
      {
        "internalType": "uint32",
        "name": "secondsOutside",
        "type": "uint32"
      },
      {
        "internalType": "bool",
        "name": "initialized",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "token0",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "token1",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "tradeFeeRate",
    "outputs": [
      {
        "internalType": "uint24",
        "name": "",
        "type": "uint24"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const
