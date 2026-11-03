import { useCallback, useEffect, useState } from 'react';

export type PermState = 'pending' | 'granted' | 'denied';

export interface PermissionsModel {
  readonly microphone: PermState;
  readonly notifications: PermState;
  readonly askMicrophone: () => Promise<void>;
  readonly askNotifications: () => Promise<void>;
  readonly recheck: () => void;
}

const FROM_QUERY: Readonly<Record<string, PermState>> = { granted: 'granted', denied: 'denied', prompt: 'pending' };

/** Reads the microphone grant without prompting. Returns null where the Permissions API cannot tell, so a known grant is never overwritten. */
export async function readMicrophone(): Promise<PermState | null> {
  try {
    // i18n-exempt: Permissions API name
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return FROM_QUERY[status.state] ?? null;
  } catch {
    return null;
  }
}

/** Asks for the grant and releases the device at once: nothing is captured here. */
export async function requestMicrophone(): Promise<PermState> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export function readNotifications(): PermState {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission === 'default' ? 'pending' : Notification.permission;
}

export async function requestNotifications(): Promise<PermState> {
  if (typeof Notification === 'undefined') return 'denied';
  try {
    await Notification.requestPermission();
  } catch {
    // Older implementations throw instead of resolving; the state read below is authoritative.
  }
  return readNotifications();
}

export function usePermissions(): PermissionsModel {
  const [microphone, setMicrophone] = useState<PermState>('pending');
  const [notifications, setNotifications] = useState<PermState>(readNotifications);
  const recheck = useCallback((): void => {
    setNotifications(readNotifications());
    void readMicrophone().then((state) => state !== null && setMicrophone(state));
  }, []);
  useEffect(() => {
    recheck();
    window.addEventListener('focus', recheck);
    return (): void => window.removeEventListener('focus', recheck);
  }, [recheck]);
  const askMicrophone = useCallback(async (): Promise<void> => setMicrophone(await requestMicrophone()), []);
  const askNotifications = useCallback(async (): Promise<void> => setNotifications(await requestNotifications()), []);
  return { microphone, notifications, askMicrophone, askNotifications, recheck };
}
