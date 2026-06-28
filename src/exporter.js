/**
 * iPad向け動画書き出し（Canvas + MediaRecorder）モジュール
 */
export class VideoExporter {
  constructor() {
    this.isExporting = false;
    this.videoEl = null;
    this.canvasEl = null;
    this.ctx = null;
    
    // Web Audio API 関連
    this.audioCtx = null;
    this.audioSource = null;
    this.audioDest = null;
    
    // MediaRecorder 関連
    this.mediaRecorder = null;
    this.recordedBlobs = [];
  }

  /**
   * 書き出しの実行
   * @param {Array} clips - クリップリスト
   * @param {number} totalDuration - 総再生時間
   * @param {Function} onProgress - 進捗コールバック (0〜100)
   * @param {Function} onComplete - 完了コールバック (Blobを返す)
   * @param {Function} onError - エラーコールバック
   */
  export(clips, totalDuration, onProgress, onComplete, onError) {
    if (this.isExporting) return;
    this.isExporting = true;
    this.recordedBlobs = [];

    // 1. レンダリング用の隠しビデオ・キャンバス要素を作成
    this.videoEl = document.createElement('video');
    this.videoEl.muted = false;
    this.videoEl.playsInline = true;
    this.videoEl.webkitPlaysInline = true;
    this.videoEl.crossOrigin = 'anonymous'; // CORS対策

    this.canvasEl = document.createElement('canvas');
    this.ctx = this.canvasEl.getContext('2d');

    // 2. Web Audio API のセットアップ (ビデオの音声をキャプチャするため)
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContextClass();
    
    try {
      this.audioSource = this.audioCtx.createMediaElementSource(this.videoEl);
      this.audioDest = this.audioCtx.createMediaStreamDestination();
      // 音声出力をデスティネーションに接続 (スピーカーには出力しないのでノイズにならない)
      this.audioSource.connect(this.audioDest);
    } catch (e) {
      console.warn('Web Audio initialization warning, continuing without audio routing:', e);
    }

    let clipIndex = 0;
    let currentVirtualTime = 0;
    let animationId = null;
    let fps = 30; // 出力フレームレート
    
    // 最初のビデオの読み込みとサイズ決定
    const firstClip = clips[0];
    this.videoEl.src = firstClip.objectURL;
    this.videoEl.load();

    this.videoEl.onloadedmetadata = () => {
      // 解像度を設定 (高解像度すぎるとiPadで重くなるため、最大 1280x720 にリサイズ)
      let width = this.videoEl.videoWidth || 1280;
      let height = this.videoEl.videoHeight || 720;
      
      const maxDimension = 1280;
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      this.canvasEl.width = width;
      this.canvasEl.height = height;

      // 3. MediaRecorder のセットアップ
      // 映像トラック（Canvasから）と音声トラック（AudioDestinationから）を結合
      const videoStream = this.canvasEl.captureStream(fps);
      const videoTrack = videoStream.getVideoTracks()[0];
      
      let combinedStream = videoStream;
      if (this.audioDest && this.audioDest.stream.getAudioTracks().length > 0) {
        const audioTrack = this.audioDest.stream.getAudioTracks()[0];
        combinedStream = new MediaStream([videoTrack, audioTrack]);
      }

      // iOS / iPad OS での動画形式の互換性チェック
      let options = { mimeType: 'video/mp4' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        // iOS/macOS Safari 等での代替フォーマット
        options = { mimeType: 'video/quicktime' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options = { mimeType: 'video/webm;codecs=vp9' };
          if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/webm' };
          }
        }
      }

      console.log(`Using mimeType: ${options.mimeType}`);

      try {
        this.mediaRecorder = new MediaRecorder(combinedStream, options);
      } catch (err) {
        console.error('Failed to create MediaRecorder:', err);
        onError(err);
        this.cleanup();
        return;
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recordedBlobs.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const superBuffer = new Blob(this.recordedBlobs, { type: options.mimeType });
        onComplete(superBuffer);
        this.cleanup();
      };

      // 4. レンダリングおよび録画プロセスの開始
      this.mediaRecorder.start();
      
      // クリップを順番に処理する非同期ループ
      const processClips = async () => {
        for (let i = 0; i < clips.length; i++) {
          if (!this.isExporting) break; // 中断処理用
          
          clipIndex = i;
          const clip = clips[i];
          
          // ソースの切り替え（最初のクリップ以外）
          if (i > 0) {
            this.videoEl.src = clip.objectURL;
            this.videoEl.load();
          }

          // ロードとシーク完了を待つ
          await new Promise((resolve) => {
            const onCanPlay = () => {
              this.videoEl.removeEventListener('canplaythrough', onCanPlay);
              this.videoEl.currentTime = clip.start;
              
              const onSeeked = () => {
                this.videoEl.removeEventListener('seeked', onSeeked);
                resolve();
              };
              this.videoEl.addEventListener('seeked', onSeeked);
            };
            this.videoEl.addEventListener('canplaythrough', onCanPlay);
          });

          // ロード完了後、一時停止解除して録画セグメントを走らせる
          // iPadブラウザで音声を正しくキャプチャするために、実際に音声を再生させてレコーディングする
          await this.audioCtx.resume();
          this.videoEl.play();

          // クリップの再生時間（秒）
          const segmentDuration = clip.end - clip.start;
          
          let lastVideoTime = -1;
          let lastStallCheckTime = performance.now();

          // Canvasへの描画ループ（クリップごと）
          await new Promise((resolveSegment) => {
            const drawFrame = () => {
              if (!this.isExporting) {
                cancelAnimationFrame(animationId);
                resolveSegment();
                return;
              }

              // Canvasに動画の現在のフレームを描画
              this.ctx.drawImage(this.videoEl, 0, 0, width, height);

              const currentVideoTime = this.videoEl.currentTime;

              // 進捗の計算
              const currentClipProgress = Math.max(0, Math.min(currentVideoTime - clip.start, segmentDuration));
              const progressTime = currentVirtualTime + currentClipProgress;
              const percent = Math.min(Math.round((progressTime / totalDuration) * 100), 99);
              onProgress(percent);

              // 進行が停止していないか（フリーズ防止安全策）
              const now = performance.now();
              if (currentVideoTime !== lastVideoTime) {
                lastVideoTime = currentVideoTime;
                lastStallCheckTime = now;
              } else {
                // currentTimeが進まずに500ms（0.5秒）以上経過した場合
                if (now - lastStallCheckTime > 500) {
                  console.warn('Video render stalled, forcing next clip.');
                  this.videoEl.pause();
                  currentVirtualTime += segmentDuration;
                  resolveSegment();
                  return;
                }
              }

              // クリップの終了位置に達したか判定 (iPad/Safariの浮動小数点誤差を考慮して0.08秒手前で終了とみなす)
              if (currentVideoTime >= clip.end - 0.08 || this.videoEl.ended) {
                this.videoEl.pause();
                currentVirtualTime += segmentDuration;
                resolveSegment();
              } else {
                animationId = requestAnimationFrame(drawFrame);
              }
            };
            animationId = requestAnimationFrame(drawFrame);
          });
        }

        // 全クリップ終了
        if (this.isExporting) {
          onProgress(100);
          this.mediaRecorder.stop();
        }
      };

      processClips().catch((err) => {
        console.error('Error during exporting clips:', err);
        onError(err);
        this.cleanup();
      });
    };

    this.videoEl.onerror = (e) => {
      console.error('Video error during export loading:', e);
      onError(new Error('動画のロードに失敗しました。'));
      this.cleanup();
    };
  }

  /**
   * 書き出しの強制キャンセル
   */
  cancel() {
    this.isExporting = false;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.cleanup();
  }

  /**
   * リソース解放
   */
  cleanup() {
    this.isExporting = false;
    
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.src = '';
      this.videoEl = null;
    }
    
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    
    this.canvasEl = null;
    this.ctx = null;
    this.mediaRecorder = null;
  }
}
