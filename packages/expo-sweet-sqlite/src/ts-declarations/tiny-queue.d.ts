// npm website: https://www.npmjs.com/package/tiny-queue
declare module 'tiny-queue' {
  /**
   * Simple FIFO queue implementation to avoid having to do `shift()`
   * on an array, which is slow.
   */
  export default class Queue<T> {
    push(element: T): void;
    /**
     * Removes the first item from the queue and returns it.
     * Returns `undefined` if the queue is empty.
     */
    shift(): T | undefined;
    /**
     * Creates new array from the queue. Doesn't clear the queue.
     * @param start
     * @param end
     */
    slice(start?: number, end?: number): T[];
    length: number;
  }
}
