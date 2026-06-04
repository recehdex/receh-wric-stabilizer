const { ethers } = require("ethers");

const CONFIG = {
  rpcUrl: "https://seed-richechain.com/",
  chainId: 132026,
  WRIC: "0xEa126036c94Ab6A384A25A70e29E2fE2D4a91e68".toLowerCase(),
  RECEH: "0x4c9C431Fa7fD104c0E7230d20E1623E62019A1C5".toLowerCase(),
  factories: {
    recehdex: "0xAeEdf8B9925c6316171f7c2815e387DE596Fa11B",
    fireswap: "0x6ed514BC91CBD202C21Bbc494d05C49fCe4bAbEf",
  },
  routers: {
    recehdex: "0x8E9556415124b6C726D5C3610d25c24Be8AC2304",
    fireswap: "0x2125Ea3C076298F13CA95e807607AE7A1369E1a8",
  },
  slippageBps: 9991,
  gasLimit: 170000,
  LOWER_BOUND: 0.9,
  TARGET_SELL: 0.97,
  UPPER_BOUND: 1,
  TARGET_BUY: 0.97,
  maxRetries: 3,
  retryDelay: 1000,
  rpcTimeout: 5000,
  loopDelay: 100,
  estimatedTxCount: 1,
};

const MULTICALL_ADDRESS = "0xa24707355a47A3D3Befff53A6a66Db0915645897";
const MULTICALL_ABI = [
  {
    constant: true,
    inputs: [
      {
        components: [
          { internalType: "address", name: "target", type: "address" },
          { internalType: "bytes", name: "callData", type: "bytes" },
        ],
        internalType: "struct Multicall2.Call[]",
        name: "calls",
        type: "tuple[]",
      },
    ],
    name: "aggregate",
    outputs: [
      { internalType: "uint256", name: "blockNumber", type: "uint256" },
      { internalType: "bytes[]", name: "returnData", type: "bytes[]" },
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
];
const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
];

let provider, signer, account, multicall;

function log(message, type = "INFO") {
  const now = new Date();
  const time = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const line = `[${time}] [${type}] ${message}`;
  console.log(line);
}

async function callWithRetry(fn, context = "") {
  let lastError;
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RPC timeout")), CONFIG.rpcTimeout),
        ),
      ]);
      return result;
    } catch (error) {
      lastError = error;
      const isRetryable =
        error.message.includes("bad response") ||
        error.message.includes("502") ||
        error.message.includes("timeout") ||
        error.code === "CALL_EXCEPTION" ||
        error.code === "SERVER_ERROR";
      if (!isRetryable) throw error;
      log(
        `RPC gagal (${context}), percobaan ${i + 1}/${CONFIG.maxRetries}: ${error.message}`,
        "WARN",
      );
      if (i < CONFIG.maxRetries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.retryDelay * Math.pow(2, i)),
        );
      }
    }
  }
  throw lastError;
}

async function getCurrentGasPrice() {
  try {
    return await provider.getGasPrice();
  } catch (e) {
    log(`Gagal mengambil gas price, menggunakan default 1.5 gwei`, "WARN");
    return ethers.utils.parseUnits("1.5", "gwei");
  }
}

function calculateSellRecehAmount(reserveRECEH, reserveWRIC, targetPrice) {
  const R = parseFloat(ethers.utils.formatEther(reserveRECEH));
  const U = parseFloat(ethers.utils.formatEther(reserveWRIC));
  const currentPrice = R / U;
  if (currentPrice >= targetPrice) return ethers.BigNumber.from(0);
  const sqrtRatio = Math.sqrt(targetPrice / currentPrice);
  const x = R * (sqrtRatio - 1);
  return ethers.utils.parseUnits(x.toFixed(6), 18);
}

function calculateBuyRecehAmount(reserveRECEH, reserveWRIC, targetPrice) {
  const R = parseFloat(ethers.utils.formatEther(reserveRECEH));
  const U = parseFloat(ethers.utils.formatEther(reserveWRIC));
  const currentPrice = R / U;
  if (currentPrice <= targetPrice) return ethers.BigNumber.from(0);
  const sqrtRatio = Math.sqrt(currentPrice / targetPrice);
  const y = U * (sqrtRatio - 1);
  return ethers.utils.parseUnits(y.toFixed(6), 18);
}

async function ensureAllowance(tokenAddr, routerAddr, gasPrice) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const allowance = await callWithRetry(
    () => token.allowance(account, routerAddr),
    `allowance ${tokenAddr}`,
  );
  if (allowance.lt(ethers.constants.MaxUint256.div(2))) {
    log(`Approve ${tokenAddr} untuk router...`);
    const tx = await callWithRetry(
      () =>
        token.approve(routerAddr, ethers.constants.MaxUint256, {
          gasPrice,
          gasLimit: CONFIG.gasLimit,
        }),
      `approve ${tokenAddr}`,
    );
    await tx.wait();
    log(`✅ Approve ${tokenAddr} berhasil`);
  }
}

async function executeSwap(
  routerAddress,
  dexName,
  tokenIn,
  tokenOut,
  amountIn,
  arah,
  hargaSaatIni,
  gasPrice,
) {
  await ensureAllowance(tokenIn, routerAddress, gasPrice);

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
  const path = [tokenIn, tokenOut];
  const amountsOut = await callWithRetry(
    () => router.getAmountsOut(amountIn, path),
    `getAmountsOut ${dexName}`,
  );
  const amountOut = amountsOut[1];
  const amountOutMin = amountOut.mul(CONFIG.slippageBps).div(10000);

  const inSymbol = tokenIn === CONFIG.WRIC ? "WRIC" : "RECEH";
  const outSymbol = tokenOut === CONFIG.WRIC ? "WRIC" : "RECEH";
  const jumlahIn = ethers.utils.formatEther(amountIn);
  log(
    `${dexName} | ${arah} | Harga: ${hargaSaatIni.toFixed(2)} RECEH/WRIC | Jumlah: ${jumlahIn} ${inSymbol} → min ${ethers.utils.formatEther(amountOutMin)} ${outSymbol}`,
  );

  const tx = await callWithRetry(
    () =>
      router.swapExactTokensForTokens(
        amountIn,
        amountOutMin,
        path,
        account,
        Math.floor(Date.now() / 1000) + 600,
        { gasPrice, gasLimit: CONFIG.gasLimit },
      ),
    `swap ${dexName}`,
  );
  await tx.wait();
  log(`✅ ${dexName} | Transaksi sukses: ${tx.hash}`);
}

async function getAllDexData() {
  const dexNames = Object.keys(CONFIG.factories);
  const calls = [];
  const factoryIface = new ethers.utils.Interface(FACTORY_ABI);
  const pairIface = new ethers.utils.Interface(PAIR_ABI);

  for (const dex of dexNames) {
    calls.push({
      target: CONFIG.factories[dex],
      callData: factoryIface.encodeFunctionData("getPair", [
        CONFIG.RECEH,
        CONFIG.WRIC,
      ]),
    });
  }

  let pairResults;
  try {
    const result = await multicall.aggregate(calls);
    pairResults = result.returnData;
  } catch (e) {
    log(`Multicall getPair gagal: ${e.message}`, "ERROR");
    return null;
  }

  const pairAddresses = [];
  const pairCalls = [];

  for (let i = 0; i < dexNames.length; i++) {
    const pairAddr = ethers.utils.defaultAbiCoder.decode(
      ["address"],
      pairResults[i],
    )[0];
    if (pairAddr === "0x0000000000000000000000000000000000000000") {
      pairAddresses.push(null);
      continue;
    }
    pairAddresses.push(pairAddr);
    pairCalls.push({
      target: pairAddr,
      callData: pairIface.encodeFunctionData("token0", []),
    });
    pairCalls.push({
      target: pairAddr,
      callData: pairIface.encodeFunctionData("token1", []),
    });
    pairCalls.push({
      target: pairAddr,
      callData: pairIface.encodeFunctionData("getReserves", []),
    });
  }

  if (pairCalls.length === 0) return dexNames.map(() => null);

  let pairDataResults;
  try {
    const result = await multicall.aggregate(pairCalls);
    pairDataResults = result.returnData;
  } catch (e) {
    log(`Multicall pair data gagal: ${e.message}`, "ERROR");
    return null;
  }

  const dexData = [];
  let dataIndex = 0;
  for (let i = 0; i < dexNames.length; i++) {
    if (!pairAddresses[i]) {
      dexData.push(null);
      continue;
    }

    const token0 = ethers.utils.defaultAbiCoder
      .decode(["address"], pairDataResults[dataIndex++])[0]
      .toLowerCase();
    const token1 = ethers.utils.defaultAbiCoder
      .decode(["address"], pairDataResults[dataIndex++])[0]
      .toLowerCase();
    const reserves = pairIface.decodeFunctionResult(
      "getReserves",
      pairDataResults[dataIndex++],
    );

    let reserveRECEH, reserveWRIC;
    if (token0 === CONFIG.RECEH && token1 === CONFIG.WRIC) {
      reserveRECEH = reserves.reserve0;
      reserveWRIC = reserves.reserve1;
    } else if (token0 === CONFIG.WRIC && token1 === CONFIG.RECEH) {
      reserveRECEH = reserves.reserve1;
      reserveWRIC = reserves.reserve0;
    } else {
      dexData.push(null);
      continue;
    }

    dexData.push({
      dex: dexNames[i],
      router: CONFIG.routers[dexNames[i]],
      reserveRECEH,
      reserveWRIC,
    });
  }
  return dexData;
}

async function processDexWithData(dexData, gasPrice) {
  if (!dexData) return;

  const { dex, router, reserveRECEH, reserveWRIC } = dexData;

  const price = reserveRECEH.mul(ethers.constants.WeiPerEther).div(reserveWRIC);
  const priceNum = parseFloat(ethers.utils.formatEther(price));
  log(`📊 Harga di ${dex}: 1 WRIC = ${priceNum.toFixed(2)} RECEH`);

  if (priceNum < CONFIG.LOWER_BOUND) {
    log(
      `⬇️ ${dex} | Harga ${priceNum.toFixed(2)} < ${CONFIG.LOWER_BOUND} → akan MENJUAL RECEH (target ${CONFIG.TARGET_SELL})`,
    );
    const amountInRECEH = calculateSellRecehAmount(
      reserveRECEH,
      reserveWRIC,
      CONFIG.TARGET_SELL,
    );
    if (amountInRECEH.isZero()) {
      log(
        `⚠️ ${dex} | Jumlah RECEH yang diperlukan nol, tidak ada aksi.`,
        "WARN",
      );
      return;
    }

    const tokenRECEH = new ethers.Contract(CONFIG.RECEH, ERC20_ABI, signer);
    const balanceRECEH = await callWithRetry(
      () => tokenRECEH.balanceOf(account),
      `balanceOf RECEH`,
    );
    if (balanceRECEH.lt(amountInRECEH)) {
      log(
        `⚠️ ${dex} | Saldo RECEH tidak cukup (butuh ${ethers.utils.formatEther(amountInRECEH)}, tersedia ${ethers.utils.formatEther(balanceRECEH)}). Swap sebanyak saldo.`,
        "WARN",
      );
      if (balanceRECEH.isZero()) {
        log(`❌ ${dex} | Saldo RECEH kosong, tidak bisa menjual.`, "WARN");
        return;
      }
      await executeSwap(
        router,
        dex,
        CONFIG.RECEH,
        CONFIG.WRIC,
        balanceRECEH,
        "JUAL RECEH",
        priceNum,
        gasPrice,
      );
    } else {
      await executeSwap(
        router,
        dex,
        CONFIG.RECEH,
        CONFIG.WRIC,
        amountInRECEH,
        "JUAL RECEH",
        priceNum,
        gasPrice,
      );
    }
  } else if (priceNum > CONFIG.UPPER_BOUND) {
    log(
      `⬆️ ${dex} | Harga ${priceNum.toFixed(2)} > ${CONFIG.UPPER_BOUND} → akan MEMBELI RECEH (target ${CONFIG.TARGET_BUY})`,
    );
    const amountInWRIC = calculateBuyRecehAmount(
      reserveRECEH,
      reserveWRIC,
      CONFIG.TARGET_BUY,
    );
    if (amountInWRIC.isZero()) {
      log(
        `⚠️ ${dex} | Jumlah WRIC yang diperlukan nol, tidak ada aksi.`,
        "WARN",
      );
      return;
    }

    const tokenWRIC = new ethers.Contract(CONFIG.WRIC, ERC20_ABI, signer);
    const balanceWRIC = await callWithRetry(
      () => tokenWRIC.balanceOf(account),
      `balanceOf WRIC`,
    );
    if (balanceWRIC.lt(amountInWRIC)) {
      log(
        `⚠️ ${dex} | Saldo WRIC tidak cukup (butuh ${ethers.utils.formatEther(amountInWRIC)}, tersedia ${ethers.utils.formatEther(balanceWRIC)}). Swap sebanyak saldo.`,
        "WARN",
      );
      if (balanceWRIC.isZero()) {
        log(`❌ ${dex} | Saldo WRIC kosong, tidak bisa membeli.`, "WARN");
        return;
      }
      await executeSwap(
        router,
        dex,
        CONFIG.WRIC,
        CONFIG.RECEH,
        balanceWRIC,
        "BELI RECEH",
        priceNum,
        gasPrice,
      );
    } else {
      await executeSwap(
        router,
        dex,
        CONFIG.WRIC,
        CONFIG.RECEH,
        amountInWRIC,
        "BELI RECEH",
        priceNum,
        gasPrice,
      );
    }
  } else {
    log(
      `⏸️ ${dex} | Harga dalam rentang normal (${CONFIG.LOWER_BOUND} - ${CONFIG.UPPER_BOUND})`,
    );
  }
}

async function runSingleCycle() {
  try {
    const gasPrice = await getCurrentGasPrice();
    const totalGasCost = gasPrice
      .mul(CONFIG.gasLimit)
      .mul(CONFIG.estimatedTxCount);
    log(
      `⛽ Estimasi total gas per eksekusi: ${ethers.utils.formatEther(totalGasCost)} RIC (gas price: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei)`,
    );

    const ricBalance = await provider.getBalance(account);
    if (ricBalance.lt(totalGasCost)) {
      log(
        `⚠️ Saldo RIC (${ethers.utils.formatEther(ricBalance)}) kurang dari estimasi gas, lewati siklus.`,
        "WARN",
      );
      return;
    }

    const dexDataList = await getAllDexData();
    if (!dexDataList) {
      log("❌ Gagal mengambil data DEX, tunggu...", "ERROR");
      return;
    }

    for (const dexData of dexDataList) {
      if (dexData) {
        await processDexWithData(dexData, gasPrice);
      } else {
        log(`⚠️ Salah satu DEX tidak memiliki pair RECEH/WRIC`, "WARN");
      }
    }
  } catch (e) {
    log(`🔥 Error dalam siklus: ${e.message}`, "ERROR");
  }
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ ERROR: PRIVATE_KEY environment variable not set!");
    process.exit(1);
  }

  try {
    provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
    await provider.getNetwork();
    const wallet = new ethers.Wallet(
      privateKey.startsWith("0x") ? privateKey : "0x" + privateKey,
      provider,
    );
    signer = wallet;
    account = await signer.getAddress();
    multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);

    log(`✅ Terhubung ke RPC. Wallet: ${account}`);
    log(`🚀 Memulai eksekusi bot...`);

    await runSingleCycle();

    log(`✅ Eksekusi selesai.`);
    process.exit(0);
  } catch (e) {
    log(`❌ Gagal inisialisasi: ${e.message}`, "ERROR");
    process.exit(1);
  }
}

main();
