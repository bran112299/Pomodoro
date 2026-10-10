// On-device image labeling + embeddings with MobileNet v2 (TensorFlow.js, WebGL). The model is
// bundled with the app (downloaded at build time), so photos never leave the computer.

import * as tf from "@tensorflow/tfjs";
import type { PhotoLabel } from "@ptu/core";
import LABELS from "./imagenet-labels.json";

const EMBEDDING_NODE = "module_apply_default/MobilenetV2/Logits/AvgPool";
const OUTPUT_NODE = "module_apply_default/MobilenetV2/Logits/output";
const SIZE = 224;

export interface VisionResult {
  labels: PhotoLabel[];
  embedding: number[];
}

export class Vision {
  private constructor(private model: tf.GraphModel) {}

  /** `modelUrl` points at the bundled model.json. */
  static async load(modelUrl: string): Promise<Vision> {
    await tf.ready();
    const model = await tf.loadGraphModel(modelUrl);
    const v = new Vision(model);
    // Warm up so the first real photo is fast.
    tf.tidy(() => {
      model.execute(tf.zeros([1, SIZE, SIZE, 3]), [OUTPUT_NODE]);
    });
    return v;
  }

  analyze(source: HTMLCanvasElement | HTMLVideoElement | ImageData, topK = 5): VisionResult {
    return tf.tidy(() => {
      const img = tf.browser.fromPixels(source).toFloat();
      // TF-Hub image modules take [0,1] RGB. Center-crop to square, then resize.
      const [h, w] = img.shape as [number, number, number];
      const s = Math.min(h, w);
      const crop = img.slice([Math.floor((h - s) / 2), Math.floor((w - s) / 2), 0], [s, s, 3]);
      const input = tf.image.resizeBilinear(crop as tf.Tensor3D, [SIZE, SIZE]).div(255).expandDims(0);
      const [pool, logits] = this.model.execute(input, [EMBEDDING_NODE, OUTPUT_NODE]) as tf.Tensor[];
      const probs = tf.softmax(logits!.reshape([-1])).dataSync();
      const embedding = Array.from(pool!.reshape([-1]).dataSync());
      const idx = Array.from(probs.keys())
        .filter((i) => i > 0) // index 0 = background
        .sort((a, b) => probs[b]! - probs[a]!)
        .slice(0, topK);
      return { labels: idx.map((i) => ({ label: (LABELS as string[])[i] ?? `class ${i}`, confidence: probs[i]! })), embedding };
    });
  }
}
