/**
 * iPad向け動画書き出し（FFmpeg.wasm使用・オリジナル画質）モジュール
 *
 * Canvas+MediaRecorder方式（再エンコード、画質劣化）から
 * FFmpeg.wasm の `-c copy` ストリームコピー方式（再エンコードなし、オリジナル画質）に変更。
 *
 * 使用ライブラリ:
 *   @ffmpeg/ffmpeg@0.12.6 + @ffmpeg/core@0.12.4 (single-threaded, SharedArrayBuffer不要)
 */

// CDN からの FFmpeg のロード状態を管理
let ffmpegLoadPromise = null;
let FFmpegModule = null;
let ffmpegInstance = null;

const FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';
const FFMPEG_CORE_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js';
const FFMPEG_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm';

/**
 * FFmpeg.wasm を初回のみ CDN からロードする
 * （以後はキャッシュ済みのインスタンスを返す）
 */
async function getFFmpeg(onLog) {
  if (ffmpegInstance) return ffmpegInstance;

  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      // FFmpeg.wasm ライブラリを動的にロード（script tag 挿入）
      if (!window.FFmpegWASM) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = FFMPEG_CDN;
          script.onload = resolve;
          script.onerror = () => reject(new Error('FFmpeg.wasm の読み込みに失敗しました。ネットワーク接続を確認してください。'));
          document.head.appendChild(script);
        });
      }

      // グローバルに公開された FFmpegWASM を取得 (UMD ビルドの公式グローバル名)
      const { FFmpeg } = window.FFmpegWASM;

      const ff = new FFmpeg();

      if (onLog) {
        ff.on('log', ({ message }) => {
          onLog(message);
        });
      }

      // シングルスレッドコアをロード（SharedArrayBuffer不要）
      await ff.load({
        coreURL: FFMPEG_CORE_CDN,
        wasmURL: FFMPEG_WASM_CDN,
      });

      ffmpegInstance = ff;
      return ff;
    })();
  }

  return ffmpegLoadPromise;
}

/**
 * Uint8Array (fetch から取得)、または Blob を FFmpeg の仮想 FS に書き込む
 */
async function writeFileToFFmpeg(ff, filename, blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  await ff.writeFile(filename, uint8Array);
}

export class VideoExporter {
  constructor() {
    this.isExporting = false;
    this._abortController = null;
  }

  /**
   * FFmpegを事前ロードしておく（UIが描画されたタイミングで呼ぶと初回書き出しが速くなる）
   */
  async preload() {
    try {
      await getFFmpeg();
      console.log('FFmpeg.wasm preloaded successfully.');
    } catch (err) {
      console.warn('FFmpeg.wasm preload failed (will retry on export):', err);
    }
  }

  /**
   * 書き出しの実行（FFmpeg.wasm ストリームコピー方式）
   *
   * @param {Array} clips - クリップリスト [ { objectURL, file, start, end, name } ]
   * @param {number} totalDuration - 総再生時間（秒）
   * @param {Function} onProgress - 進捗コールバック (0〜100)
   * @param {Function} onComplete - 完了コールバック (Blobを返す)
   * @param {Function} onError - エラーコールバック
   */
  async export(clips, totalDuration, onProgress, onComplete, onError) {
    if (this.isExporting) return;
    this.isExporting = true;

    try {
      // 1. FFmpeg.wasm のロード
      onProgress(1);
      let ff;
      try {
        ff = await getFFmpeg((msg) => console.debug('[FFmpeg]', msg));
      } catch (err) {
        throw new Error(`FFmpeg.wasm の初期化に失敗しました: ${err.message}`);
      }
      onProgress(5);

      // 一意のセッション ID でファイル名が衝突しないようにする
      const sessionId = Date.now();

      // 2. ソースファイルを FFmpeg の仮想 FS に書き込む
      //    同一の objectURL（＝同一ファイル）は1回だけ書き込む
      const writtenFiles = new Map(); // objectURL → 仮想FSのファイル名

      onProgress(8);
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        if (writtenFiles.has(clip.objectURL)) continue;

        const ext = this._getExtension(clip.name);
        const inputFilename = `input_${sessionId}_${writtenFiles.size}${ext}`;

        // Blob を取得して仮想 FS に書き込む
        const response = await fetch(clip.objectURL);
        const blob = await response.blob();
        await writeFileToFFmpeg(ff, inputFilename, blob);

        writtenFiles.set(clip.objectURL, inputFilename);
        onProgress(8 + Math.round((i / clips.length) * 30)); // 8% → 38%
      }

      onProgress(40);

      // 3. 各クリップをストリームコピーでトリム → 個別ファイルに出力
      const trimmedFiles = [];

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const inputFilename = writtenFiles.get(clip.objectURL);
        const outputFilename = `segment_${sessionId}_${i}.mp4`;

        const startSec = clip.start.toFixed(6);
        const durationSec = (clip.end - clip.start).toFixed(6);

        // -c copy でストリームをコピー（再エンコードなし＝オリジナル画質）
        // -avoid_negative_ts make_zero: タイムスタンプのずれを防止
        // -movflags +faststart: Web再生向け最適化
        await ff.exec([
          '-ss', startSec,
          '-i', inputFilename,
          '-t', durationSec,
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-movflags', '+faststart',
          outputFilename,
        ]);

        trimmedFiles.push(outputFilename);

        const progress = 40 + Math.round(((i + 1) / clips.length) * 45); // 40% → 85%
        onProgress(progress);
      }

      // 4. 複数クリップを concat demuxer で連結
      let finalOutputFilename;

      if (trimmedFiles.length === 1) {
        // クリップが1つだけの場合はそのままでOK
        finalOutputFilename = trimmedFiles[0];
      } else {
        // concat リストファイルを生成（FFmpeg concat demuxer 用）
        const concatContent = trimmedFiles
          .map(f => `file '${f}'`)
          .join('\n');

        const concatFilename = `concat_list_${sessionId}.txt`;
        const encoder = new TextEncoder();
        await ff.writeFile(concatFilename, encoder.encode(concatContent));

        finalOutputFilename = `output_${sessionId}.mp4`;

        await ff.exec([
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFilename,
          '-c', 'copy',
          '-movflags', '+faststart',
          finalOutputFilename,
        ]);

        // 中間ファイルのクリーンアップ
        for (const segFile of trimmedFiles) {
          try { await ff.deleteFile(segFile); } catch (_) {}
        }
        try { await ff.deleteFile(concatFilename); } catch (_) {}
      }

      onProgress(90);

      // 5. 出力ファイルを FFmpeg 仮想 FS から読み出す
      const outputData = await ff.readFile(finalOutputFilename);
      const outputBlob = new Blob([outputData.buffer], { type: 'video/mp4' });

      // 6. 仮想 FS のクリーンアップ
      try { await ff.deleteFile(finalOutputFilename); } catch (_) {}
      for (const [, fname] of writtenFiles) {
        try { await ff.deleteFile(fname); } catch (_) {}
      }

      onProgress(100);
      onComplete(outputBlob);

    } catch (err) {
      console.error('Export error:', err);
      onError(err);
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * ファイル名から拡張子を安全に取得する
   */
  _getExtension(filename) {
    if (!filename) return '.mp4';
    const match = filename.match(/\.[^.]+$/);
    return match ? match[0].toLowerCase() : '.mp4';
  }

  /**
   * 書き出しの強制キャンセル（FFmpeg.wasm は現時点では中断が困難なため、フラグ制御のみ）
   */
  cancel() {
    this.isExporting = false;
    console.warn('Export cancel requested. FFmpeg.wasm operation may continue briefly.');
  }
}
