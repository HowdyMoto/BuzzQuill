/**
 * imagetracerjs ships no types. Only the two entry points this app uses are
 * declared — `imagedataToTracedata` (structured layers/paths/segments, which we
 * turn into real elements) and `checkoptions` (option defaults, used in tests).
 */
declare module 'imagetracerjs' {
  interface ImageTracerModule {
    imagedataToTracedata(
      imgd: { width: number; height: number; data: Uint8ClampedArray },
      options?: Record<string, unknown>,
    ): unknown;
    checkoptions(options?: Record<string, unknown>): Record<string, unknown>;
  }
  const ImageTracer: ImageTracerModule;
  export default ImageTracer;
}
