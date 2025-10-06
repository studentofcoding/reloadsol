export const devWallets = [
    // Add your dev wallet addresses here
    '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX',
    // 'FrKWJKLDvTn4ghZSkMXTSERPA7KowWLds2vsMw7QpvNk',
    '2KbA4Z1twQCYZj4MNvX5RKNKh8vWGpiQbGBPcAjtBpYS'
];

export const isDevWallet = (address: string): boolean => {
    const isDev = devWallets.includes(address);
    return isDev;
};