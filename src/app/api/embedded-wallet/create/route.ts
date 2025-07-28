import { NextRequest, NextResponse } from 'next/server';
import { crossmintWalletService } from '@/utils/crossmint-wallet';
import { adminSupabase } from '@/utils/supabase';

export async function POST(request: NextRequest) {
    try {
        const { userId, email } = await request.json();

        if (!userId && !email) {
            return NextResponse.json(
                { error: 'Either User ID or email is required' },
                { status: 400 }
            );
        }

        // Create a unique identifier for the user
        const userIdentifier = email || userId;
        const locatorType = email ? 'email' : 'userId';

        // Check if user already has an embedded wallet
        const { data: existingWallet, error: checkError } = await adminSupabase
            .from('embedded_wallets')
            .select('*')
            .eq('user_id', userIdentifier)
            .eq('is_active', true)
            .single();

        // Handle the case where no wallet exists (this is expected for new users)
        if (checkError && checkError.code !== 'PGRST116') {
            console.error('Database check error:', checkError);
            return NextResponse.json(
                { error: 'Failed to check existing wallet' },
                { status: 500 }
            );
        }

        if (existingWallet) {
            return NextResponse.json({
                success: true,
                wallet: existingWallet,
                message: 'Wallet already exists'
            });
        }

        // Create new Crossmint wallet
        console.log('Creating wallet for:', { userId, email, userIdentifier });

        const crossmintWallet = await crossmintWalletService.createWallet({
            userId: locatorType === 'userId' ? userIdentifier : undefined,
            email: locatorType === 'email' ? userIdentifier : undefined,
            chain: 'solana'
        });

        console.log('Crossmint wallet created:', crossmintWallet);

        // Store wallet info in database using adminSupabase
        const { data: newWallet, error: dbError } = await adminSupabase
            .from('embedded_wallets')
            .insert({
                user_id: userIdentifier,
                email: email || null, // ✅ Fixed: Don't use userIdentifier as email
                crossmint_wallet_id: crossmintWallet.address,
                wallet_address: crossmintWallet.address,
                wallet_type: 'crossmint-custodial',
                is_active: true,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (dbError) {
            console.error('Database error:', dbError);
            return NextResponse.json(
                { error: `Failed to save wallet to database: ${dbError.message}` },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            wallet: newWallet,
            crossmintWallet,
            message: 'Embedded wallet created successfully'
        });

    } catch (error: any) {
        console.error('Error creating embedded wallet:', error);
        return NextResponse.json(
            { error: `Failed to create embedded wallet: ${error.message}` },
            { status: 500 }
        );
    }
}