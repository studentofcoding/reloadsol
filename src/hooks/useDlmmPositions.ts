import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DlmmAgentConfig, DlmmLesson, DlmmPosition } from '@/types/dlmm';
import type { DlmmDbStatus } from '@/utils/dlmm/db-status';

const DLMM_PASSWORD_KEY = 'dlmmApiPassword';

export function getDlmmPassword(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(DLMM_PASSWORD_KEY) || 'earlytrencher';
}

export function setDlmmPassword(password: string) {
  localStorage.setItem(DLMM_PASSWORD_KEY, password);
}

function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json', 'x-dlmm-password': getDlmmPassword() };
}

export function useDlmmPositions() {
  return useQuery({
    queryKey: ['dlmm-positions'],
    queryFn: async () => {
      const res = await fetch('/api/dlmm/positions?lessons=true');
      const data = await res.json();
      if (!data.positions && !data.success) {
        throw new Error(data.error || 'Failed to fetch positions');
      }
      return data as {
        success: boolean;
        positions: DlmmPosition[];
        lessons?: DlmmLesson[];
        dbStatus?: DlmmDbStatus;
      };
    },
    refetchInterval: 15_000,
  });
}

export function useDlmmConfig() {
  return useQuery({
    queryKey: ['dlmm-config'],
    queryFn: async () => {
      const res = await fetch('/api/dlmm/config');
      const data = await res.json();
      if (!data.config) throw new Error(data.error || 'Failed to fetch config');
      return data as {
        success: boolean;
        config: DlmmAgentConfig;
        dbStatus?: DlmmDbStatus;
        usingEnvFallback?: boolean;
      };
    },
    refetchInterval: 30_000,
  });
}

export function useDeployPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      poolAddress: string;
      amountSol: number;
      binRangeInterval?: number;
    }) => {
      const res = await fetch('/api/dlmm/positions', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Deploy failed');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dlmm-positions'] });
    },
  });
}

export function useEditPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      takeProfitPct?: number;
      stopLossPct?: number;
      oorTimeoutMin?: number;
      binRangeInterval?: number;
      muted?: boolean;
    }) => {
      const res = await fetch(`/api/dlmm/positions/${id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Edit failed');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dlmm-positions'] });
    },
  });
}

export function useRemovePosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/dlmm/positions/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Remove failed');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dlmm-positions'] });
    },
  });
}

export function useUpdateDlmmConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<DlmmAgentConfig>) => {
      const res = await fetch('/api/dlmm/config', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Config update failed');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dlmm-config'] });
    },
  });
}
