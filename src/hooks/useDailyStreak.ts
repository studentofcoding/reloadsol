'use client';

import { useCallback, useSyncExternalStore } from 'react';

function isSameDay(a: Date, b: Date) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function daysBetween(a: Date, b: Date) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.floor((utcB - utcA) / msPerDay);
}

function readStreak(walletAddress?: string) {
    if (!walletAddress || typeof window === 'undefined') {
        return { count: 0, last: null as Date | null };
    }
    const c = parseInt(localStorage.getItem(`streak_count_${walletAddress}`) || '0', 10) || 0;
    const d = localStorage.getItem(`streak_last_${walletAddress}`);
    return { count: c, last: d ? new Date(d) : null };
}

function writeStreak(walletAddress: string, count: number, last: Date) {
    localStorage.setItem(`streak_count_${walletAddress}`, String(count));
    localStorage.setItem(`streak_last_${walletAddress}`, last.toISOString());
}

type StreakStore = {
    walletAddress: string | undefined;
    count: number;
    listeners: Set<() => void>;
};

const store: StreakStore = {
    walletAddress: undefined,
    count: 0,
    listeners: new Set(),
};

function emitChange() {
    store.listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
}

function getSnapshot() {
    return store.count;
}

function getServerSnapshot() {
    return 0;
}

function syncStreakForWallet(walletAddress?: string) {
    if (walletAddress === store.walletAddress) {
        return;
    }

    store.walletAddress = walletAddress;

    if (!walletAddress) {
        store.count = 0;
        emitChange();
        return;
    }

    const today = new Date();
    const { count, last } = readStreak(walletAddress);

    if (!last) {
        writeStreak(walletAddress, 1, today);
        store.count = 1;
        emitChange();
        return;
    }

    if (isSameDay(last, today)) {
        store.count = count;
        emitChange();
        return;
    }

    const diff = daysBetween(last, today);
    const nextCount = diff === 1 ? count + 1 : 1;
    writeStreak(walletAddress, nextCount, today);
    store.count = nextCount;
    emitChange();
}

export function useDailyStreak(walletAddress?: string) {
    syncStreakForWallet(walletAddress);
    const streak = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    const markActiveToday = useCallback(() => {
        if (!walletAddress) return;
        const today = new Date();
        const { count, last } = readStreak(walletAddress);

        if (!last) {
            writeStreak(walletAddress, 1, today);
            store.count = 1;
            emitChange();
            return;
        }

        if (isSameDay(last, today)) {
            store.count = count;
            emitChange();
            return;
        }

        const diff = daysBetween(last, today);
        const nextCount = diff === 1 ? count + 1 : 1;
        writeStreak(walletAddress, nextCount, today);
        store.count = nextCount;
        emitChange();
    }, [walletAddress]);

    return { streak, markActiveToday };
}
