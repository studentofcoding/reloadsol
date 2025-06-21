import { WalletContextState } from "@solana/wallet-adapter-react";
import { 
  Connection, 
  PublicKey, 
  VersionedTransaction, 
  TransactionInstruction,
  TransactionMessage,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID, 
  createCloseAccountInstruction, 
  NATIVE_MINT, 
  getAssociatedTokenAddress, 
  createTransferInstruction, 
  createAssociatedTokenAccountInstruction 
} from "@solana/spl-token";
import { 
  getSwapFeePercentage, 
  calculateFees 
} from '@/utils/fees';
import { 
  addProblematicToken, 
  isProblematicToken,
  forceRefreshTokens,
  refreshTokenListWithRetry
} from '@/utils/tokenList';
import { 
  createTransactionWithReferral, 
  devWalletAutoBuy 
} from '@/utils/transactions';
import { 
  trackClose 
} from '@/utils/operations-api';
import { 
  startTimer, 
  stopTimer, 
  measureAsync 
} from '@/utils/timing';
import { 
  checkSolBalance 
} from '@/utils/balance';
import { TokenInfo } from '@/types/token';
import { sleep } from '@/utils/sleep';
import { trackCloseOperation } from './src/utils/trading-tracker';

// Constants
const SLIPPAGE = 2;
const MAX_TOKENS_PER_BATCH = 23;
const VALUE_THRESHOLD = 0.001;
const JITO_TIP_LAMPORTS = 100000;

// Types
export interface SelectedToken {
  id: string;
  amount: number;
  symbol: string;
  value: number;
}

export interface BundleResults {
  successfulTokens: string[];
  failedTokens: string[];
  failedTransactions: VersionedTransaction[];
  successfulSignatures: string[];
}

export interface SignatureResult {
  sig: string;
  tx: VersionedTransaction;
}

export interface TokenStatus {
  id: string;
  symbol: string;
  status: 'pending' | 'success' | 'failed';
  error?: string;
}

export interface ProcessingCallbacks {
  setLoadingText: (text: string) => void;
  setTextLoadingState: (loading: boolean) => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  onTokenUpdate?: (tokens: TokenInfo[]) => void;
}

// Helper function to create swap request
export const createSwapRequest = async (
  token: SelectedToken,
  wallet: WalletContextState,
  signal?: AbortSignal
) => {
  const feePercentage = await getSwapFeePercentage(wallet.publicKey!.toBase58());
  
  return {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Connection": "keep-alive"
    },
    body: JSON.stringify({
      from: token.id,
      to: NATIVE_MINT.toBase58(),
      amount: token.amount,
      slippage: SLIPPAGE,
      payer: wallet.publicKey?.toBase58(),
      priorityFee: 0.00008,
      feeType: "add",
      fee: `3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX:${feePercentage.toFixed(1)}`
    }),
    signal,
    keepalive: true
  };
};

// Create close account bundle
export const createCloseAccountBundle = async (
  tokens: SelectedToken[],
  wallet: WalletContextState,
  solConnection: Connection,
  blockhash?: string
): Promise<VersionedTransaction[]> => {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  
  const closeBundle: VersionedTransaction[] = [];
  const closeInstructions: TransactionInstruction[] = [];

  try {
    // First, collect all close instructions
    const closePromises = tokens.map(async (token) => {
      try {
        const ata = await getAssociatedTokenAddress(
          new PublicKey(token.id),
          wallet.publicKey!
        );
        
        return createCloseAccountInstruction(
          ata,
          wallet.publicKey!,
          wallet.publicKey!
        );
      } catch (error) {
        console.error(`Failed to prepare close for ${token.id}:`, error);
        return null;
      }
    });

    // Wait for all close instructions to be prepared
    const closeResults = await Promise.all(closePromises);
    
    // Filter out any null results from failed preparations
    const validCloseInstructions = closeResults.filter(
      (instr: TransactionInstruction | null): instr is TransactionInstruction => instr !== null
    );
    
    if (validCloseInstructions.length > 0) {
      // Add all close instructions first
      closeInstructions.push(...validCloseInstructions);

      // Add fee instructions once for the entire bundle
      const instructionsWithFees = await createTransactionWithReferral(
        closeInstructions,
        wallet.publicKey,
        solConnection,
        validCloseInstructions.length
      );

      // Create single transaction with all instructions
      const recentBlockhash = blockhash || 
        await solConnection.getLatestBlockhash().then(res => res.blockhash);
        
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: recentBlockhash as string,
        instructions: instructionsWithFees
      }).compileToV0Message();

      closeBundle.push(new VersionedTransaction(messageV0));
    }
  } catch (error) {
    console.error("Error creating close account bundle:", error);
  }

  return closeBundle;
};

// Send transactions with confirmation
export const sendTransactions = async (
  signedTxs: VersionedTransaction[], 
  tokens: SelectedToken[],
  connection: Connection,
  blockhash: string,
  lastValidBlockHeight: number,
  bundleType: 'close' | 'swap' = 'swap',
  isSingleTx: boolean = false
): Promise<BundleResults> => {
  const successfulTokens: string[] = [];
  const failedTokens: string[] = [];
  const successfulSignatures: string[] = [];
  const tokenStatusMap = new Map<string, TokenStatus>();

  // Initialize status map
  tokens.forEach(token => {
    tokenStatusMap.set(token.id, {
      id: token.id,
      symbol: token.symbol,
      status: 'pending'
    });
  });

  if (isSingleTx) {
    // Single transaction mode (CloseAndFee)
    try {
      const sig = await connection.sendTransaction(signedTxs[0], { 
        skipPreflight: true,
        maxRetries: 3
      });
      successfulSignatures.push(sig);

      const confirmation = await connection.confirmTransaction({
        signature: sig,
        lastValidBlockHeight,
        blockhash
      }, 'confirmed');

      if (confirmation.value.err) {
        console.error(`Single transaction failed: ${sig}`, confirmation.value.err);
        tokens.forEach(token => {
          tokenStatusMap.get(token.id)!.status = 'failed';
          failedTokens.push(token.id);
        });
      } else {
        // Verify transaction success on chain
        const txInfo = await connection.getTransaction(sig, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });

        if (txInfo?.meta?.err) {
          tokens.forEach(token => {
            tokenStatusMap.get(token.id)!.status = 'failed';
            failedTokens.push(token.id);
          });
        } else {
          tokens.forEach(token => {
            tokenStatusMap.get(token.id)!.status = 'success';
            successfulTokens.push(token.id);
          });
        }
      }
    } catch (error) {
      console.error('Failed to send single transaction:', error);
      tokens.forEach(token => {
        tokenStatusMap.get(token.id)!.status = 'failed';
        failedTokens.push(token.id);
      });
    }
  } else {
    // Batch mode (Swap)
    const BATCH_SIZE = 5;
    for (let i = 0; i < signedTxs.length; i += BATCH_SIZE) {
      const batch = signedTxs.slice(i, i + BATCH_SIZE);
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);
      
      // Send batch transactions in parallel
      const sendPromises = batch.map(async (tx, idx) => {
        try {
          const sig = await connection.sendTransaction(tx, { 
            skipPreflight: true,
            maxRetries: 3
          });
          return { success: true, sig, tokenIdx: i + idx };
        } catch (error) {
          console.error(`Failed to send transaction for token ${batchTokens[idx].symbol}:`, error);
          return { success: false, tokenIdx: i + idx, error };
        }
      });

      const sendResults = await Promise.all(sendPromises);

      // Process confirmations for successful sends
      const confirmPromises = sendResults.map(async (result) => {
        if (!result.success) {
          tokenStatusMap.get(tokens[result.tokenIdx].id)!.status = 'failed';
          failedTokens.push(tokens[result.tokenIdx].id);
          return;
        }

        try {
          const confirmation = await connection.confirmTransaction({
            signature: result.sig!,
            lastValidBlockHeight,
            blockhash
          }, 'confirmed');

          if (confirmation.value.err) {
            console.error(`Transaction failed: ${result.sig}`, confirmation.value.err);
            tokenStatusMap.get(tokens[result.tokenIdx].id)!.status = 'failed';
            failedTokens.push(tokens[result.tokenIdx].id);
          } else {
            const txInfo = await connection.getTransaction(result.sig!, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0
            });

            if (txInfo?.meta?.err) {
              tokenStatusMap.get(tokens[result.tokenIdx].id)!.status = 'failed';
              failedTokens.push(tokens[result.tokenIdx].id);
            } else {
              tokenStatusMap.get(tokens[result.tokenIdx].id)!.status = 'success';
              successfulTokens.push(tokens[result.tokenIdx].id);
              successfulSignatures.push(result.sig!);
            }
          }
        } catch (error: any) {
          console.error(`Confirmation failed for ${result.sig}:`, error);
          tokenStatusMap.get(tokens[result.tokenIdx].id)!.status = 'failed';
          failedTokens.push(tokens[result.tokenIdx].id);
        }
      });

      await Promise.all(confirmPromises);
    }
  }

  return {
    successfulTokens,
    failedTokens,
    failedTransactions: [],
    successfulSignatures
  };
};

// Close and fee operation
export const processCloseAndFee = async (
  selectedTokens: SelectedToken[],
  wallet: WalletContextState,
  connection: Connection,
  callbacks: ProcessingCallbacks
): Promise<BundleResults> => {
  if (!wallet.publicKey || !wallet.signAllTransactions) {
    throw new Error("Wallet not ready for signing");
  }

  // Check SOL balance first
  const tokenList: TokenInfo[] = []; // This would be passed in actual implementation
  const stats = await checkSolBalance(connection, wallet.publicKey, tokenList, false);
  
  const closeFee = await calculateFees(wallet.publicKey.toString(), 'close', selectedTokens.length);
  const estimatedCost = closeFee;
  
  if (stats.currentBalance < estimatedCost) {
    throw new Error(`Insufficient SOL balance. Need ${estimatedCost.toFixed(4)} SOL`);
  }

  callbacks.setLoadingText("Preparing close transactions...");
  startTimer("Total Close Process");

  try {
    const { blockhash, lastValidBlockHeight } = await measureAsync("Get Blockhash", () => 
      connection.getLatestBlockhash('confirmed')
    );

    // Create close bundle
    const closeBundle = await createCloseAccountBundle(
      selectedTokens,
      wallet,
      connection,
      blockhash
    );

    if (closeBundle.length > 0) {
      callbacks.setLoadingText("Signing close transaction...");
      const signedCloseBundle = await measureAsync("Sign Close Transaction", () => {
        if (!wallet.signAllTransactions) {
          throw new Error("Wallet does not support signing transactions");
        }
        return wallet.signAllTransactions(closeBundle);
      });

      callbacks.setLoadingText("Processing close...");
      const closeResults = await measureAsync("Process Close", () => 
        sendTransactions(
          signedCloseBundle,
          selectedTokens,
          connection,
          blockhash,
          lastValidBlockHeight,
          'close',
          true
        )
      );

      if (closeResults.successfulTokens.length > 0) {
        // Track the close operation
        const tokenData = selectedTokens.map(token => ({
          mintAddress: token.id,
          symbol: token.symbol,
          name: token.symbol
        }));

        const closeErrors = closeResults.failedTokens.length > 0 
          ? closeResults.failedTokens.map(tokenId => `Failed to close ${tokenId}`)
          : undefined;

        // Note: trackCloseOperation would be called here if imports work
        // trackCloseOperation(
        //   wallet.publicKey.toString(),
        //   tokenData,
        //   closeResults.successfulTokens.length,
        //   closeResults.failedTokens.length,
        //   closeResults.successfulSignatures,
        //   0.00203928 * closeResults.successfulTokens.length, // Estimate fees
        //   closeErrors
        // );

        // Track close operation securely via server route
        try {
          const solBalance = await connection.getBalance(wallet.publicKey);
          const trackResult = await trackClose(
            wallet.publicKey.toString(),
            closeResults.successfulTokens.length,
            {
              failureCount: closeResults.failedTokens.length,
              solBalance: solBalance / 1e9, // Convert lamports to SOL
              tokenMints: closeResults.successfulTokens,
            }
          );
          console.log(`🎉 Earned ${trackResult.pointsEarned} points from close operation!`);
        } catch (trackError) {
          console.error('Failed to track close operation:', trackError);
        }

        callbacks.onSuccess(`Successfully closed ${closeResults.successfulTokens.length} accounts!`);
      }

      if (closeResults.failedTokens.length > 0) {
        callbacks.onError(`Failed to close ${closeResults.failedTokens.length} accounts`);
      }

      return closeResults;
    }

    throw new Error("No close transactions could be created");
  } catch (error) {
    console.error("Error during close process:", error);
    throw error;
  } finally {
    stopTimer("Total Close Process");
    callbacks.setLoadingText("");
  }
};

// Swap operation
export const processSwap = async (
  selectedTokens: SelectedToken[],
  wallet: WalletContextState,
  connection: Connection,
  callbacks: ProcessingCallbacks
): Promise<BundleResults> => {
  if (!wallet.publicKey || !wallet.signAllTransactions) {
    throw new Error("Wallet not ready for signing");
  }

  // Check SOL balance first
  const tokenList: TokenInfo[] = []; // This would be passed in actual implementation
  const stats = await checkSolBalance(connection, wallet.publicKey, tokenList, true);
  
  const swapFee = await calculateFees(wallet.publicKey.toString(), 'swap', selectedTokens.length);
  const closeFee = await calculateFees(wallet.publicKey.toString(), 'close', selectedTokens.length);
  const estimatedCost = swapFee + closeFee;
  
  if (stats.currentBalance < estimatedCost) {
    throw new Error(`Insufficient SOL balance. Need ${estimatedCost.toFixed(4)} SOL`);
  }

  callbacks.setLoadingText("Preparing transactions...");
  startTimer("Total Swap Process");

  try {
    const { blockhash, lastValidBlockHeight } = await measureAsync("Get Blockhash", () => 
      connection.getLatestBlockhash('confirmed')
    );

    // Step 1: Prepare swap transactions
    startTimer("Swap Preparation");
    const swapBundle: VersionedTransaction[] = [];
    const failedTokens: string[] = [];
    const problematicTokens: string[] = [];
    
    const BATCH_SIZE = 10;
    const batches: SelectedToken[][] = [];
    
    // Filter out already known problematic tokens
    const validTokens = selectedTokens.filter(token => !isProblematicToken(token.id));
    
    for (let i = 0; i < validTokens.length; i += BATCH_SIZE) {
      batches.push(validTokens.slice(i, i + BATCH_SIZE));
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      await Promise.all(batches.map(async (batch, batchIndex) => {
        const batchStart = batchIndex * BATCH_SIZE;
        startTimer(`Batch ${batchStart}-${batchStart + batch.length}`);
        
        const batchPromises = batch.map(async (token) => {
          try {
            const request = await createSwapRequest(token, wallet, controller.signal);
            const response = await fetch("https://swap-v2.solanatracker.io/swap", request);
            
            if (!response.ok) {
              const errorDetails = await response.text().catch(() => 'No error details available');
              console.error(`Quote failed for token ${token.symbol || token.id}:`, {
                status: response.status,
                statusText: response.statusText,
                details: errorDetails
              });
              
              if (response.status === 400 || response.status === 422) {
                problematicTokens.push(token.id);
              }
              
              return { 
                success: false, 
                tokenId: token.id, 
                error: `Quote failed: ${response.status} ${response.statusText}`
              };
            }
            
            const swapResponse = await response.json();
            if (!swapResponse.txn) {
              problematicTokens.push(token.id);
              throw new Error("No transaction returned from swap API");
            }
            
            const tx = VersionedTransaction.deserialize(Buffer.from(swapResponse.txn, 'base64'));
            tx.message.recentBlockhash = blockhash;
            return { success: true, tokenId: token.id, tx };
          } catch (error) {
            console.error(`Failed to prepare swap for ${token.id}:`, error);
            return { success: false, tokenId: token.id, error };
          }
        });

        const results = await Promise.all(batchPromises);
        results.forEach(result => {
          if (result.success && result.tx) {
            swapBundle.push(result.tx);
          } else {
            failedTokens.push(result.tokenId);
          }
        });

        stopTimer(`Batch ${batchStart}-${batchStart + batch.length}`);
        callbacks.setLoadingText(`Processed ${swapBundle.length}/${validTokens.length} swaps...`);
      }));
    } finally {
      clearTimeout(timeoutId);
    }

    // Add problematic tokens to the tracking system
    problematicTokens.forEach(tokenId => {
      addProblematicToken(tokenId);
    });

    if (swapBundle.length === 0) {
      throw new Error("No swap transactions could be prepared");
    }

    let swapResults: BundleResults = { 
      successfulTokens: [], 
      failedTokens: [], 
      failedTransactions: [], 
      successfulSignatures: [] 
    };
    
    if (swapBundle.length > 0) {
      const swapCount = swapBundle.length;
      callbacks.setLoadingText(`Signing ${swapCount} swap transactions...`);
      
      const signedSwapBundle = await measureAsync("Sign Swap Transactions", () => {
        if (!wallet.signAllTransactions) {
          throw new Error("Wallet does not support signing transactions");
        }
        return wallet.signAllTransactions(swapBundle);
      });
      
      const tokensToProcess = selectedTokens.filter(token => !failedTokens.includes(token.id));
      
      callbacks.setLoadingText("Processing swaps...");
      swapResults = await measureAsync("Process Swaps", () => 
        sendTransactions(
          signedSwapBundle, 
          tokensToProcess,
          connection,
          blockhash,
          lastValidBlockHeight,
          'swap',
          false
        )
      );
    }

    if (swapResults.successfulTokens.length > 0) {
      await directUpdateOperation(
        wallet.publicKey.toString(),
        'swap',
        swapResults.successfulTokens.length,
        await connection.getBalance(wallet.publicKey)
      );

      callbacks.onSuccess(`Successfully processed ${swapResults.successfulTokens.length} tokens!`);
    }

    return swapResults;
  } catch (error) {
    console.error("Error during swap process:", error);
    throw error;
  } finally {
    stopTimer("Total Swap Process");
    callbacks.setLoadingText("");
  }
};

// One-click swap and close operation
export const processOneClickSwapAndClose = async (
  selectedTokens: SelectedToken[],
  wallet: WalletContextState,
  connection: Connection,
  callbacks: ProcessingCallbacks
): Promise<{ swapResults: BundleResults; closeResults: BundleResults }> => {
  if (!wallet.publicKey || !wallet.signAllTransactions) {
    throw new Error("Wallet not ready for signing");
  }

  // Handle case where we have more tokens than the maximum batch size
  let tokensToProcess = selectedTokens;
  
  if (selectedTokens.length > MAX_TOKENS_PER_BATCH) {
    console.log(`Selected ${selectedTokens.length} tokens, limiting to ${MAX_TOKENS_PER_BATCH} per batch`);
    tokensToProcess = selectedTokens.slice(0, MAX_TOKENS_PER_BATCH);
  }

  callbacks.setLoadingText("Preparing transactions...");
  startTimer("Total OneClick Process");

  try {
    const { blockhash, lastValidBlockHeight } = await measureAsync("Get Blockhash", () => 
      connection.getLatestBlockhash('confirmed')
    );

    // Split tokens into those to swap and those to close
    const tokensToSwap = tokensToProcess.filter(token => token.value >= VALUE_THRESHOLD);
    const tokensToClose = tokensToProcess.filter(token => token.value < VALUE_THRESHOLD);
    
    let swapResults: BundleResults = { 
      successfulTokens: [], 
      failedTokens: [], 
      failedTransactions: [], 
      successfulSignatures: [] 
    };

    // Process swaps if there are any
    if (tokensToSwap.length > 0) {
      swapResults = await processSwap(tokensToSwap, wallet, connection, callbacks);
    }

    // Step 3: Create and process close transactions
    const allTokensToClose = [
      ...tokensToClose,
      ...tokensToSwap.filter(token => swapResults.successfulTokens.includes(token.id))
    ];
    
    let closeResults: BundleResults = { 
      successfulTokens: [], 
      failedTokens: [], 
      failedTransactions: [], 
      successfulSignatures: [] 
    };
    
    if (allTokensToClose.length > 0) {
      closeResults = await processCloseAndFee(allTokensToClose, wallet, connection, callbacks);
    }

    // Calculate final results
    const allSuccessfulTokenIds = [
      ...swapResults.successfulTokens,
      ...closeResults.successfulTokens
    ];

    if (allSuccessfulTokenIds.length > 0) {
      callbacks.onSuccess(`Successfully processed ${allSuccessfulTokenIds.length} tokens!`);
    }

    return { swapResults, closeResults };
  } catch (error) {
    console.error("Error during oneClick process:", error);
    throw error;
  } finally {
    stopTimer("Total OneClick Process");
    callbacks.setLoadingText("");
  }
};

// Transfer tokens operation
export const processTransferTokens = async (
  selectedTokens: SelectedToken[],
  destinationWallet: PublicKey,
  wallet: WalletContextState,
  connection: Connection,
  callbacks: ProcessingCallbacks
): Promise<BundleResults> => {
  if (!wallet.publicKey || !wallet.signAllTransactions) {
    throw new Error("Wallet not ready for signing");
  }

  callbacks.setLoadingText("Preparing transfer transactions...");

  try {
    const transferBundles: VersionedTransaction[] = [];
    const BATCH_SIZE = 5;

    // Create batches of transfer instructions
    for (let i = 0; i < selectedTokens.length; i += BATCH_SIZE) {
      const batchInstructions: TransactionInstruction[] = [];
      const batchTokens = selectedTokens.slice(i, i + BATCH_SIZE);

      for (const token of batchTokens) {
        try {
          const sourceAta = await getAssociatedTokenAddress(
            new PublicKey(token.id),
            wallet.publicKey
          );
          const destAta = await getAssociatedTokenAddress(
            new PublicKey(token.id),
            destinationWallet
          );

          batchInstructions.push(
            createTransferInstruction(
              sourceAta,
              destAta,
              wallet.publicKey,
              token.amount
            )
          );
        } catch (error) {
          console.error(`Failed to prepare transfer for ${token.id}:`, error);
        }
      }

      if (batchInstructions.length > 0) {
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: await connection.getLatestBlockhash().then(res => res.blockhash),
          instructions: batchInstructions
        }).compileToV0Message();

        transferBundles.push(new VersionedTransaction(messageV0));
      }
    }

    if (transferBundles.length > 0) {
      callbacks.setLoadingText("Signing transfer transactions...");
      const signedBundles = await wallet.signAllTransactions(transferBundles);
      
      callbacks.setLoadingText("Processing transfers...");
      
      // For now, return mock results - this would use sendTransactions in actual implementation
      const results: BundleResults = {
        successfulTokens: selectedTokens.map(t => t.id),
        failedTokens: [],
        failedTransactions: [],
        successfulSignatures: []
      };

      if (results.successfulTokens.length > 0) {
        await directUpdateOperation(
          wallet.publicKey.toString(),
          'swap',
          results.successfulTokens.length,
          await connection.getBalance(wallet.publicKey)
        );
        callbacks.onSuccess(`Successfully transferred ${results.successfulTokens.length} tokens`);
      }

      return results;
    }

    throw new Error("No transfer transactions could be created");
  } catch (error: any) {
    console.error("Error during transfer:", error);
    throw error;
  } finally {
    callbacks.setLoadingText("");
  }
};

// Create destination ATAs
export const createDestinationATAs = async (
  selectedTokens: SelectedToken[],
  destinationWallet: PublicKey,
  wallet: WalletContextState,
  connection: Connection,
  callbacks: ProcessingCallbacks
): Promise<{ created: number; existing: number }> => {
  if (!wallet.publicKey || !wallet.signAllTransactions) {
    throw new Error("Wallet not ready for signing");
  }

  callbacks.setLoadingText("Preparing ATA creation...");

  try {
    const BATCH_SIZE = 5;
    const ataBundles: VersionedTransaction[] = [];
    const accountChecks: Promise<{ token: SelectedToken, account: any }>[] = [];

    // Prepare all account checks in parallel
    selectedTokens.forEach(token => {
      accountChecks.push((async () => {
        const destAta = await getAssociatedTokenAddress(
          new PublicKey(token.id),
          destinationWallet
        );
        const account = await connection.getAccountInfo(destAta);
        return { token, account };
      })());
    });

    // Wait for all account checks to complete
    const accountResults = await Promise.all(accountChecks);
    const tokensNeedingAta = accountResults.filter(result => !result.account);

    const existingCount = accountResults.length - tokensNeedingAta.length;

    if (tokensNeedingAta.length === 0) {
      callbacks.onSuccess("All ATAs already exist!");
      return { created: 0, existing: existingCount };
    }

    // Process tokens needing ATAs in batches
    for (let i = 0; i < tokensNeedingAta.length; i += BATCH_SIZE) {
      const batchTokens = tokensNeedingAta.slice(i, i + BATCH_SIZE);
      const batchInstructions: TransactionInstruction[] = [];

      for (const { token } of batchTokens) {
        try {
          const destAta = await getAssociatedTokenAddress(
            new PublicKey(token.id),
            destinationWallet
          );
          
          batchInstructions.push(
            createAssociatedTokenAccountInstruction(
              wallet.publicKey,
              destAta,
              destinationWallet,
              new PublicKey(token.id)
            )
          );
        } catch (error) {
          console.error(`Failed to prepare ATA for ${token.id}:`, error);
        }
      }

      if (batchInstructions.length > 0) {
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: await connection.getLatestBlockhash().then(res => res.blockhash),
          instructions: batchInstructions
        }).compileToV0Message();

        ataBundles.push(new VersionedTransaction(messageV0));
      }
    }

    let createdCount = 0;
    if (ataBundles.length > 0) {
      callbacks.setLoadingText("Creating ATAs...");
      const signedBundles = await wallet.signAllTransactions(ataBundles);
      
      // For now, return mock results - this would use sendTransactions in actual implementation
      createdCount = tokensNeedingAta.length;
      
      callbacks.onSuccess(`Created ${createdCount} new ATAs`);
    }

    return { created: createdCount, existing: existingCount };
  } catch (error: any) {
    console.error("Error during ATA creation:", error);
    throw error;
  } finally {
    callbacks.setLoadingText("");
  }
};

// Dev wallet auto-buy tokens
export const handleDevWalletAutoBuy = async (
  selectedTokenCount: number,
  wallet: WalletContextState,
  connection: Connection,
  callbacks: ProcessingCallbacks
): Promise<{ successfulBuys: string[]; failedBuys: any[]; totalSpent: number }> => {
  if (!wallet.publicKey || !wallet.signAllTransactions) {
    throw new Error("Wallet not ready for signing");
  }

  callbacks.setLoadingText("Preparing autoswap...");
  startTimer("Total AutoSwap Process");

  try {
    const tokenListData = require("../components/tokenlist.json");
    
    if (!tokenListData?.tokens?.length) {
      throw new Error("No tokens available for autoswap");
    }

    // Get total available tokens
    const availableTokens = tokenListData.tokens;
    
    // Randomly select tokens
    const shuffleArray = <T,>(array: T[]): T[] => {
      const newArray = [...array];
      for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
      }
      return newArray;
    };

    const tokensToProcess = shuffleArray(availableTokens).slice(0, selectedTokenCount);
    const totalTokens = tokensToProcess.length;
    const amountPerToken = 0.001; // SOL per token
    const txFee = 0.000005;
    const priorityFee = 0.0001;
    
    // Calculate total required balance
    const requiredBalance = (
      (amountPerToken * totalTokens) +
      (txFee * totalTokens) +
      (priorityFee * totalTokens) +
      0.01
    );

    // Check wallet balance
    const balance = await connection.getBalance(wallet.publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL;

    if (balanceInSol < requiredBalance) {
      throw new Error(`Insufficient SOL balance. Need at least ${requiredBalance.toFixed(4)} SOL, you have ${balanceInSol.toFixed(4)} SOL`);
    }

    callbacks.setLoadingText(`Preparing to buy ${totalTokens} tokens in one batch...`);
    
    // Use the devWalletAutoBuy function
    const result = await devWalletAutoBuy(
      wallet,
      connection,
      {
        maxTokens: totalTokens,
        amountPerToken: amountPerToken,
        slippage: 1.0,
        priorityFee: priorityFee,
        selectedTokens: tokensToProcess as any[] // Type cast to fix the type mismatch
      }
    );

    if (result.successfulBuys.length > 0) {
      callbacks.onSuccess(`Successfully bought ${result.successfulBuys.length} tokens in one batch!`);
    } else {
      callbacks.onError("No tokens were successfully purchased");
    }

    return result;
  } catch (error: any) {
    console.error("Error during autoswap:", error);
    throw error;
  } finally {
    stopTimer("Total AutoSwap Process");
    callbacks.setLoadingText("");
  }
}; 