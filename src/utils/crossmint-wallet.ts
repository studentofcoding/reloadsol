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
                linkedUser = `email:${params.email}`;
            } else if (params.userId) {
                linkedUser = `userId:${params.userId}`;
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

    async signTransaction(params: SignTransactionParams): Promise<SignatureResponse> {
        try {
            const response = await axios.post(
                `${this.baseUrl}/wallets/${params.walletLocator}/signatures`,
                {
                    type: 'solana-transaction',
                    params: {
                        transaction: params.transaction,
                        chain: params.chain
                    }
                },
                { headers: this.getHeaders() }
            );

            return response.data;
        } catch (error: any) {
            console.error('Failed to sign transaction:', error.response?.data || error.message);
            throw new Error('Failed to sign transaction');
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
    createWalletLocator(type: 'email' | 'userId', value: string): string {
        return `${type}:${value}`;
    }
}

export const crossmintWalletService = new CrossmintWalletService();
export type { WalletResponse, CreateWalletParams, SignTransactionParams, SignatureResponse };