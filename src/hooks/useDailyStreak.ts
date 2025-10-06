'use client';

import { useCallback, useEffect, useState } from 'react';

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

export function useDailyStreak(walletAddress?: string) {
    const [streak, setStreak] = useState<number>(0);

    const read = useCallback(() => {
        if (!walletAddress) return { count: 0, last: null as Date | null };
        const c = parseInt(localStorage.getItem(`streak_count_${walletAddress}`) || '0', 10) || 0;
        const d = localStorage.getItem(`streak_last_${walletAddress}`);
        return { count: c, last: d ? new Date(d) : null };
    }, [walletAddress]);

    const write = useCallback((count: number, last: Date) => {
        if (!walletAddress) return;
        localStorage.setItem(`streak_count_${walletAddress}`, String(count));
        localStorage.setItem(`streak_last_${walletAddress}`, last.toISOString());
        setStreak(count);
    }, [walletAddress]);

    const markActiveToday = useCallback(() => {
        if (!walletAddress) return;
        const today = new Date();
        const { count, last } = read();

        if (!last) {
            write(1, today);
            return;
        }

        if (isSameDay(last, today)) {
            setStreak(count);
            return;
        }

        const diff = daysBetween(last, today);
        if (diff === 1) {
            write(count + 1, today);
        } else {
            write(1, today);
        }
    }, [walletAddress, read, write]);

    useEffect(() => {
        if (!walletAddress) {
            setStreak(0);
            return;
        }
        const { count, last } = read();
        if (!last) {
            markActiveToday();
            return;
        }
        const today = new Date();
        if (isSameDay(last, today)) {
            setStreak(count);
        } else {
            // Treat visiting the app as “active”
            markActiveToday();
        }
    }, [walletAddress, read, markActiveToday]);

    return { streak, markActiveToday };
}