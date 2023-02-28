import { Logger } from '@nestjs/common';
import { ExceptionHandler } from './exception-handler';

const DEFAULT_TEARDOWN = () => process.exit(1);

/* It's a wrapper around the `try/catch` block that allows you to run a function and handle any
exceptions that occur */
export class ExceptionsZone {
  private static readonly exceptionHandler = new ExceptionHandler();

  public static run(
    callback: () => void,
    teardown: (err: any) => void = DEFAULT_TEARDOWN,
    autoFlushLogs?: boolean,
  ) {
    try {
      callback();
    } catch (e) {
      this.exceptionHandler.handle(e);
      if (autoFlushLogs) {
        Logger.flush();
      }
      teardown(e);
    }
  }

  public static async asyncRun(
    callback: () => Promise<void>,
    teardown: (err: any) => void = DEFAULT_TEARDOWN,
    autoFlushLogs?: boolean,
  ) {
    try {
      await callback();
    } catch (e) {
      this.exceptionHandler.handle(e);
      if (autoFlushLogs) {
        Logger.flush();
      }
      teardown(e);
    }
  }
}
