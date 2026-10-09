import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from './config.ts';
export function acquireProcessLock(directory: string) {
  privateDirectory(directory);
  const path = join(directory, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
        } catch {
          /* gone */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('서버 잠금 파일을 확인하세요.');
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          unlinkSync(path);
          continue;
        }
      }
      throw new Error('같은 데이터 경로의 서버가 이미 실행 중입니다.');
    }
  }
  throw new Error('서버 잠금을 확보하지 못했습니다.');
}
