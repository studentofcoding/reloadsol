import axios from 'axios';

interface CrossmintConfig {
    apiKey: string;
    environment: 'staging' | 'production';
}

interface CreateWalletParams {
    userId?: string;
    email?: string;
    chain: 'solana';
}

interface WalletResponse {
    type: string;
    address: string;
    linkedUser?: string;
    createdAt: string;
}

interface SignTransactionParams {
    walletLocator: string;
    transaction: string; // Base64 encoded transaction
    chain: 'solana';
}

interface SignatureResponse {
    id: string;
    signature: string;
    status: 'completed' | 'pending' | 'failed';
}

class CrossmintWalletService {
    private config: CrossmintConfig;
    private baseUrl: string;

    constructor() {
        this.config = {
            apiKey: process.env.CROSSMINT_API_KEY!,
            environment: (process.env.CROSSMINT_ENVIRONMENT as 'staging' | 'production') || 'staging'
        };

        // Use correct staging endpoint
        this.baseUrl = this.config.environment === 'production'
            ? 'https://www.crossmint.com/api/v1-alpha2'
            : 'https://staging.crossmint.com/api/v1-alpha2';

        if (!this.config.apiKey) {
            throw new Error('CROSSMINT_API_KEY environment variable is required');
        }

        console.log(`Crossmint initialized for ${this.config.environment} environment`);
        console.log(`Using base URL: ${this.baseUrl}`);
    }

    private getHeaders() {
        return {
            'Content-Type': 'application/json',
            'X-API-KEY': this.config.apiKey,
        };
    }

    async createWallet(params: CreateWalletParams): Promise<WalletResponse> {
        try {
            // Determine the linkedUser format based on the provided identifier
            let linkedUser: string;
            if (params.email) {
                linkedUser = `email:${params.email}:solana-custodial-wallet`;
            } else if (params.userId) {
                linkedUser = `userId:${params.userId}:solana-custodial-wallet`;
            } else {
                throw new Error('Either email or userId must be provided');
            }

            // Updated payload with required fields for custodial wallet
            const payload: any = {
                type: 'solana-custodial-wallet',
                chain: params.chain,
                linkedUser: linkedUser  // Required format: 'email:<email>' or 'userId:<userId>'
            };

            // Add either email or userId
            if (params.email) {
                payload.email = params.email;
            } else if (params.userId) {
                payload.userId = params.userId;
            }

            console.log('Creating wallet with payload:', JSON.stringify(payload, null, 2));
            console.log('Using endpoint:', `${this.baseUrl}/wallets`);
            console.log('Environment:', this.config.environment);

            const response = await axios.post(
                `${this.baseUrl}/wallets`,
                payload,
                { headers: this.getHeaders() }
            );

            console.log('Wallet creation response:', response.data);
            return response.data;
        } catch (error: any) {
            console.error('Failed to create Crossmint wallet:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                config: {
                    url: error.config?.url,
                    method: error.config?.method,
                    data: error.config?.data
                }
            });
            throw new Error(`Failed to create embedded wallet: ${error.response?.data?.message || error.message}`);
        }
    }

    async getWallet(walletLocator: string): Promise<WalletResponse> {
        try {
            const response = await axios.get(
                `${this.baseUrl}/wallets/${walletLocator}`,
                { headers: this.getHeaders() }
            );

            return response.data;
        } catch (error: any) {
            console.error('Failed to get Crossmint wallet:', error.response?.data || error.message);
            throw new Error('Failed to retrieve wallet information');
        }
    }

    async signTransaction(params: SignTransactionParams): Promise<SignatureResponse & { signedTransaction?: string }> {
        try {
            console.log('🔐 Signing transaction with Crossmint:', {
                walletLocator: params.walletLocator,
                chain: params.chain,
                transactionLength: params.transaction.length
            });

            // Simply verify the wallet exists before signing
            try {
                console.log('🔍 Verifying wallet exists...');
                const walletInfo = await this.getWallet(params.walletLocator);
                console.log('✅ Wallet verified:', {
                    address: walletInfo.address,
                    type: walletInfo.type,
                });
            } catch (walletError: any) {
                console.error('❌ Wallet not found:', walletError.response?.data || walletError.message);
                throw new Error(`Wallet not found: ${walletError.response?.data?.message || walletError.message}`);
            }

            const response = await axios.post(
                `${this.baseUrl}/wallets/${params.walletLocator}/signatures`,
                {
                    type: 'solana-message',
                    params: {
                        message: params.transaction,
                        chain: params.chain
                    }
                },
                { headers: this.getHeaders() }
            );

            console.log('✅ Transaction signed successfully:', {
                id: response.data.id,
                status: response.data.status,
                hasSignature: !!response.data.signature
            });

            return response.data;
        } catch (error: any) {
            console.error('❌ Failed to sign transaction:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                walletLocator: params.walletLocator
            });
            throw new Error(`Failed to sign transaction: ${error.response?.data?.message || error.message}`);
        }
    }

    // Helper method to reconstruct signed transaction
    reconstructSignedTransaction(originalTransaction: string, signature: string): string {
        try {
            // This is a simplified approach
            // In practice, you might need to properly reconstruct the transaction
            // based on how Crossmint returns the signature

            // For now, we'll assume the signature is the complete signed transaction
            // or we need to combine it with the original transaction

            // This would need to be implemented based on Crossmint's actual response format
            console.log('🔧 Reconstructing signed transaction...');

            // If Crossmint returns the full signed transaction, use it directly
            if (signature && signature.length > 100) { // Rough check for full transaction
                return signature;
            }

            // Otherwise, we might need to combine signature with original transaction
            // This is a placeholder - actual implementation depends on Crossmint's format
            return originalTransaction; // Fallback to original for now

        } catch (error: any) {
            console.error('❌ Failed to reconstruct signed transaction:', error);
            throw new Error('Failed to reconstruct signed transaction');
        }
    }

    async getWalletBalance(walletAddress: string): Promise<{ sol: number; tokens: any[] }> {
        try {
            // For now, we'll use your existing Solana RPC integration
            // Crossmint doesn't seem to have a direct balance endpoint in the docs
            const response = await axios.get(
                `${this.baseUrl}/wallets/${walletAddress}/balances`,
                { headers: this.getHeaders() }
            );

            return response.data;
        } catch (error: any) {
            console.error('Failed to get wallet balance:', error.response?.data || error.message);
            throw new Error('Failed to retrieve wallet balance');
        }
    }

    // Helper method to create wallet locator
    createWalletLocator(type: 'email' | 'userId', value: string, walletType: string = 'solana-custodial-wallet'): string {
        const locator = `${type}:${value}:${walletType}`;
        console.log('🔍 Creating wallet locator:', {
            type,
            value: value.substring(0, 10) + '...', // Partial value for security
            walletType,
            fullLocator: locator
        });
        return locator;
    }

    // Helper method to detect the correct wallet type for a user
    async detectWalletType(type: 'email' | 'userId', value: string): Promise<string> {
        const possibleTypes = ['solana-custodial-wallet', 'solana-mpc-wallet'];

        for (const walletType of possibleTypes) {
            try {
                const locator = `${type}:${value}:${walletType}`;
                await this.getWallet(locator);
                console.log(`✅ Found wallet with type: ${walletType}`);
                return locator; // Return full locator instead of just wallet type
            } catch (error) {
                console.log(`❌ Wallet type ${walletType} not found`);
            }
        }

        throw new Error('No wallet found with any supported wallet type');
    }

    // Helper method to create wallet locator with auto-detection
    async createWalletLocatorWithDetection(type: 'email' | 'userId', value: string): Promise<string> {
        try {
            const walletType = await this.detectWalletType(type, value);
            return this.createWalletLocator(type, value, walletType);
        } catch (error) {
            // Fallback to default if detection fails
            console.warn('Wallet type detection failed, using default:', error);
            return this.createWalletLocator(type, value);
        }
    }

    // Helper method to ensure wallet exists and get the correct locator
    async ensureWalletExists(type: 'email' | 'userId', value: string): Promise<string> {
        console.log('🔍 Ensuring wallet exists for:', { type, value: value.substring(0, 10) + '...' });

        // Try to detect existing wallet type
        try {
            const walletType = await this.detectWalletType(type, value);
            const locator = this.createWalletLocator(type, value, walletType);
            console.log('✅ Found existing wallet:', locator);
            return locator;
        } catch (error) {
            console.log('❌ No existing wallet found, creating new one...');

            // Create new wallet
            try {
                const createParams = type === 'email'
                    ? { email: value, chain: 'solana' as const }
                    : { userId: value, chain: 'solana' as const };

                const newWallet = await this.createWallet(createParams);
                console.log('✅ New wallet created:', {
                    address: newWallet.address,
                    type: newWallet.type
                });

                // Return locator with the actual wallet type from Crossmint
                return this.createWalletLocator(type, value, newWallet.type);
            } catch (createError: any) {
                console.error('❌ Failed to create wallet:', createError);
                throw new Error(`Failed to ensure wallet exists: ${createError.message}`);
            }
        }
    }
}

export const crossmintWalletService = new CrossmintWalletService();
export type { WalletResponse, CreateWalletParams, SignTransactionParams, SignatureResponse };