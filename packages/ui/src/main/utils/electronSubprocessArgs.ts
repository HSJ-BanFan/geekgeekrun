import { resolve } from 'path'

export function electronSubprocessArgs(...args: string[]) {
  if (process.env.NODE_ENV === 'development' || (process as any).defaultApp) {
    return [resolve(process.argv[1]), ...args]
  }
  return args
}
