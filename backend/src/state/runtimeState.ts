let ready = false;

export function setReadyState(value: boolean) {
  ready = value;
}

export function isReady(): boolean {
  return ready;
}

