'use client';

import { useCallback, useEffect, useState } from 'react';

function isSameDay(a: Date, b: Date) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function daysBetween(a: Date, b: Date) {
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.floor((utcB - utcA) / (24 * 60 * 60 * 1000));
}

function readStreak(walletAddress: string) {
    const c = parseInt(localStorage.getItem(`streak_count_${walletAddress}`) || '0', 10) || 0;
    const d = localStorage.getItem(`streak_last_${walletAddress}`);
    return { count: c, last: d ? new Date(d) : null };
}

function writeStreak(walletAddress: string, count: number, last: Date) {
    localStorage.setItem(`streak_count_${walletAddress}`, String(count));
    localStorage.setItem(`streak_last_${walletAddress}`, last.toISOString());
}

function computeStreakCount(walletAddress: string): number {
    const today = new Date();
    const { count, last } = readStreak(walletAddress);

    if (!last) {
        writeStreak(walletAddress, 1, today);
        return 1;
    }

    if (isSameDay(last, today)) {
        return count;
    }

    const diff = daysBetween(last, today);
    const nextCount = diff === 1 ? count + 1 : 1;
    writeStreak(walletAddress, nextCount, today);
    return nextCount;
}

export function useDailyStreak(walletAddress?: string) {
    const [streak, setStreak] = useState(0);

    useEffect(() => {
        if (!walletAddress) return;
        const next = computeStreakCount(walletAddress);
        queueMicrotask(() => setStreak(next));
    }, [walletAddress]);

    const markActiveToday = useCallback(() => {
        if (!walletAddress) return;
        setStreak(computeStreakCount(walletAddress));
    }, [walletAddress]);

    return { streak: walletAddress ? streak : 0, markActiveToday };
}
