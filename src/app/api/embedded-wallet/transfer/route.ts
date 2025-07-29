import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { Connection, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { createConnection } from '@/utils/connection';

interface BulkTransferRequest {
    userId: string;
    destinationWallet: string;
    transfers: Array<{
        type: 'SOL' | 'TOKEN';
        amount: number;
        mint?: string;
        decimals?: number;
    }>;
}

interface TransferResult {
    type: 'SOL' | 'TOKEN';
    mint?: string;
    amount: number;
    success: boolean;
    signature?: string;
    error?: string;
}

export async function POST(request: NextRequest) {
    try {
        const { userId, destinationWallet, transfers }: BulkTransferRequest = await request.json();

        if (!userId || !destinationWallet || !transfers || transfers.length === 0) {
            return NextResponse.json(
                { error: 'User ID, destination wallet, and transfers are required' },
                { status: 400 }
            );
        }

        // Validate destination wallet address
        try {
            new PublicKey(destinationWallet);
        } catch {
            return NextResponse.json(
                { error: 'Invalid destination wallet address' },
                { status: 400 }
            );
        }

        // Get user's embedded wallet from database
        const { data: walletData, error: walletError } = await supabase
            .from('embedded_wallets')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .single();

        if (walletError || !walletData) {
            return NextResponse.json(
                { error: 'Embedded wallet not found for user' },
                { status: 404 }
            );
        }

        const connection = createConnection('mainnet');
        const sourceWallet = new PublicKey(walletData.wallet_address);
        const destinationWalletPubkey = new PublicKey(destinationWallet);

        const results: TransferResult[] = [];

        // Process each transfer
        for (const transfer of transfers) {
            try {
                if (transfer.type === 'SOL') {
                    // SOL Transfer
                    const lamports = Math.floor(transfer.amount * 1e9);

                    const transaction = new Transaction().add(
                        SystemProgram.transfer({
                            fromPubkey: sourceWallet,
                            toPubkey: destinationWalletPubkey,
                            lamports
                        })
                    );

                    // Get recent blockhash
                    const { blockhash } = await connection.getLatestBlockhash();
                    transaction.recentBlockhash = blockhash;
                    transaction.feePayer = sourceWallet;

                    // Sign transaction using Crossmint API
                    const signResponse = await fetch('/api/embedded-wallet/sign', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            userId,
                            transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64')
                        })
                    });

                    if (!signResponse.ok) {
                        throw new Error('Failed to sign SOL transfer transaction');
                    }

                    const { signedTransaction } = await signResponse.json();
                    const signature = await connection.sendRawTransaction(
                        Buffer.from(signedTransaction, 'base64'),
                        { skipPreflight: false }
                    );

                    // Confirm transaction
                    await connection.confirmTransaction(signature, 'confirmed');

                    results.push({
                        type: 'SOL',
                        amount: transfer.amount,
                        success: true,
                        signature
                    });

                } else if (transfer.type === 'TOKEN' && transfer.mint) {
                    // Token Transfer
                    const mintPubkey = new PublicKey(transfer.mint);
                    const sourceTokenAccount = await getAssociatedTokenAddress(mintPubkey, sourceWallet);
                    const destinationTokenAccount = await getAssociatedTokenAddress(mintPubkey, destinationWalletPubkey);

                    const transaction = new Transaction();

                    // Check if destination token account exists
                    const destinationAccountInfo = await connection.getAccountInfo(destinationTokenAccount);
                    if (!destinationAccountInfo) {
                        // Create associated token account
                        transaction.add(
                            createAssociatedTokenAccountInstruction(
                                sourceWallet, // payer
                                destinationTokenAccount,
                                destinationWalletPubkey, // owner
                                mintPubkey
                            )
                        );
                    }

                    // Add transfer instruction
                    const transferAmount = Math.floor(transfer.amount * Math.pow(10, transfer.decimals || 0));
                    transaction.add(
                        createTransferInstruction(
                            sourceTokenAccount,
                            destinationTokenAccount,
                            sourceWallet,
                            transferAmount
                        )
                    );

                    // Get recent blockhash
                    const { blockhash } = await connection.getLatestBlockhash();
                    transaction.recentBlockhash = blockhash;
                    transaction.feePayer = sourceWallet;

                    // Sign transaction using Crossmint API
                    const signResponse = await fetch('/api/embedded-wallet/sign', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            userId,
                            transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64')
                        })
                    });

                    if (!signResponse.ok) {
                        throw new Error('Failed to sign token transfer transaction');
                    }

                    const { signedTransaction } = await signResponse.json();
                    const signature = await connection.sendRawTransaction(
                        Buffer.from(signedTransaction, 'base64'),
                        { skipPreflight: false }
                    );

                    // Confirm transaction
                    await connection.confirmTransaction(signature, 'confirmed');

                    results.push({
                        type: 'TOKEN',
                        mint: transfer.mint,
                        amount: transfer.amount,
                        success: true,
                        signature
                    });
                }

            } catch (error: any) {
                console.error(`Transfer failed for ${transfer.type}:`, error);
                results.push({
                    type: transfer.type,
                    mint: transfer.mint,
                    amount: transfer.amount,
                    success: false,
                    error: error.message
                });
            }
        }

        // Log bulk transfer completion
        console.log('Bulk transfer completed:', {
            userId,
            sourceWallet: sourceWallet.toString(),
            destinationWallet,
            totalTransfers: transfers.length,
            successfulTransfers: results.filter(r => r.success).length,
            failedTransfers: results.filter(r => !r.success).length
        });

        return NextResponse.json({
            success: true,
            results,
            summary: {
                total: results.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length
            }
        });

    } catch (error: any) {
        console.error('Bulk transfer failed:', error);
        return NextResponse.json(
            { error: `Bulk transfer failed: ${error.message}` },
            { status: 500 }
        );
    }
}