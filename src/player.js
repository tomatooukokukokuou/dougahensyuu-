/**
 * iPad向けダブルバッファリング対応シームレス動画プレイヤー
 */
export class SeamlessPlayer {
  constructor(containerEl, onTimeUpdate, onEnded) {
    this.container = containerEl;
    this.onTimeUpdate = onTimeUpdate;
    this.onEnded = onEnded;

    this.clips = [];
    this.isPlaying = false;
    this.virtualTime = 0; // タイムライン全体における仮想再生時間 (秒)
    this.totalDuration = 0;

    // iPadのビデオ再生制限解除フラグ
    this.isUnlocked = false;

    // もともとHTMLにあったplaceholderとvideoを取得
    this.placeholder = document.getElementById('video-placeholder');
    const originalVideo = document.getElementById('main-video');
    if (originalVideo) {
      originalVideo.remove(); // 動的生成に切り替えるため削除
    }

    // ダブルバッファ用ビデオ要素の生成
    this.videoA = document.createElement('video');
    this.videoB = document.createElement('video');

    [this.videoA, this.videoB].forEach((video, index) => {
      video.playsInline = true;
      video.webkitPlaysInline = true;
      video.muted = false; // 音声あり
      video.preload = 'auto';
      video.style.position = 'absolute';
      video.style.top = '0';
      video.style.left = '0';
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      video.style.opacity = '0';
      video.style.transition = 'opacity 0.2s ease-in-out';
      video.style.pointerEvents = 'none';
      video.style.zIndex = index === 0 ? '2' : '1';
      this.container.appendChild(video);
    });

    this.activeVideo = this.videoA;
    this.inactiveVideo = this.videoB;
    this.activeVideo.style.opacity = '1';

    this.activeClipIndex = -1;
    this.animationFrameId = null;
    this.lastTime = 0;

    this.setupEvents();
  }

  setupEvents() {
    // 再生状態の監視やエラー処理が必要な場合はここに追加
    const handleError = (e) => {
      console.error('Video playing error:', e);
    };
    this.videoA.addEventListener('error', handleError);
    this.videoB.addEventListener('error', handleError);
  }

  /**
   * iOSブラウザの自動再生/外部再生制限を解除する
   */
  unlock() {
    if (this.isUnlocked) return;
    
    // 空のデータを再生させてユーザーインタラクションの制限を解除
    const unlockVideo = (video) => {
      video.play().then(() => {
        video.pause();
      }).catch(err => {
        console.warn('Unlock failed or not needed:', err);
      });
    };

    unlockVideo(this.videoA);
    unlockVideo(this.videoB);
    this.isUnlocked = true;
  }

  /**
   * クリップリストを更新する
   */
  setClips(clips) {
    this.clips = clips;
    this.calculateTotalDuration();
    
    if (this.clips.length > 0) {
      if (this.placeholder) this.placeholder.style.opacity = '0';
      
      // クリップリストが変更された場合、現在の再生位置が妥当かチェック
      if (this.virtualTime > this.totalDuration) {
        this.seek(0);
      } else {
        this.seek(this.virtualTime);
      }
    } else {
      if (this.placeholder) this.placeholder.style.opacity = '1';
      this.pause();
      this.virtualTime = 0;
      this.activeVideo.src = '';
      this.inactiveVideo.src = '';
      this.activeClipIndex = -1;
      this.onTimeUpdate(0);
    }
  }

  calculateTotalDuration() {
    this.totalDuration = this.clips.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
  }

  /**
   * クリップのインデックスと、その中での相対時間を仮想時間から求める
   */
  getClipIndexAndTimeAt(virtualTime) {
    let accumulatedTime = 0;
    for (let i = 0; i < this.clips.length; i++) {
      const clip = this.clips[i];
      const clipDuration = clip.end - clip.start;
      if (virtualTime <= accumulatedTime + clipDuration) {
        return {
          index: i,
          clipTime: clip.start + (virtualTime - accumulatedTime),
          clipStartVirtualTime: accumulatedTime
        };
      }
      accumulatedTime += clipDuration;
    }
    // 末尾
    if (this.clips.length > 0) {
      const lastIdx = this.clips.length - 1;
      return {
        index: lastIdx,
        clipTime: this.clips[lastIdx].end,
        clipStartVirtualTime: accumulatedTime - (this.clips[lastIdx].end - this.clips[lastIdx].start)
      };
    }
    return { index: -1, clipTime: 0, clipStartVirtualTime: 0 };
  }

  /**
   * 仮想再生位置にシークする
   */
  seek(virtualTime) {
    this.virtualTime = Math.max(0, Math.min(virtualTime, this.totalDuration));
    
    if (this.clips.length === 0) return;

    const { index, clipTime } = this.getClipIndexAndTimeAt(this.virtualTime);
    
    if (index !== this.activeClipIndex) {
      this.activeClipIndex = index;
      const activeClip = this.clips[this.activeClipIndex];
      
      // アクティブビデオのソースを切り替え
      this.activeVideo.src = activeClip.objectURL;
      this.activeVideo.currentTime = clipTime;
      
      // 非アクティブビデオに次のクリップをプリロード
      this.preloadNextClip(index);
    } else {
      // 同じクリップ内なら時間を変えるだけ
      // iPadでのシーク負荷軽減のため、再生中でないか、あるいは差が大きい時のみシーク
      if (!this.isPlaying || Math.abs(this.activeVideo.currentTime - clipTime) > 0.3) {
        this.activeVideo.currentTime = clipTime;
      }
    }

    this.onTimeUpdate(this.virtualTime);
  }

  /**
   * 次のクリップを非アクティブビデオに読み込んでおく
   */
  preloadNextClip(currentClipIndex) {
    const nextIndex = currentClipIndex + 1;
    if (nextIndex < this.clips.length) {
      const nextClip = this.clips[nextIndex];
      if (this.inactiveVideo.src !== nextClip.objectURL) {
        this.inactiveVideo.removeAttribute('src');
        this.inactiveVideo.load();
        this.inactiveVideo.src = nextClip.objectURL;
        this.inactiveVideo.currentTime = nextClip.start;
        this.inactiveVideo.preload = 'auto';
      }
    } else {
      this.inactiveVideo.src = '';
    }
  }

  play() {
    if (this.isPlaying || this.clips.length === 0) return;
    this.unlock(); // 再生時に制限を解除

    if (this.virtualTime >= this.totalDuration) {
      this.seek(0);
    }

    this.isPlaying = true;
    this.lastTime = performance.now();
    
    // アクティブなビデオを再生
    this.activeVideo.play().then(() => {
      this.startLoop();
    }).catch(err => {
      console.error('Play failed:', err);
      this.isPlaying = false;
    });
  }

  pause() {
    this.isPlaying = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.activeVideo.pause();
    this.inactiveVideo.pause();
  }

  /**
   * メインの再生ループ
   */
  startLoop() {
    const loop = () => {
      if (!this.isPlaying) return;

      const activeClip = this.clips[this.activeClipIndex];
      if (!activeClip) {
        this.pause();
        return;
      }

      // 1. アクティブなビデオの再生時間から仮想再生時間を逆算
      const { clipStartVirtualTime } = this.getClipIndexAndTimeAt(this.virtualTime);
      const currentVideoTime = this.activeVideo.currentTime;
      
      // 仮想時間を更新
      this.virtualTime = clipStartVirtualTime + (currentVideoTime - activeClip.start);
      this.onTimeUpdate(this.virtualTime);

      // 2. クリップの終了位置（カット位置）に達したか判定
      const clipEnded = currentVideoTime >= activeClip.end - 0.05; // わずかな誤差マージン

      if (clipEnded) {
        const nextIndex = this.activeClipIndex + 1;
        if (nextIndex < this.clips.length) {
          // 次のクリップへスイッチ（ダブルバッファリング）
          this.switchVideoBuffer(nextIndex);
        } else {
          // タイムライン全体の終了
          this.virtualTime = this.totalDuration;
          this.onTimeUpdate(this.virtualTime);
          this.pause();
          if (this.onEnded) this.onEnded();
          return;
        }
      }

      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  /**
   * バッファビデオの切り替え処理（シームレス接続）
   */
  switchVideoBuffer(nextIndex) {
    const nextClip = this.clips[nextIndex];
    
    // 非アクティブビデオ（次に再生するもの）を再生開始
    // 事前に preload して currentTime がセットされている前提
    this.inactiveVideo.currentTime = nextClip.start;
    
    this.inactiveVideo.play().then(() => {
      // フェード/表示切り替え
      this.inactiveVideo.style.opacity = '1';
      this.inactiveVideo.style.zIndex = '2';
      this.activeVideo.style.opacity = '0';
      this.activeVideo.style.zIndex = '1';
      
      // 旧アクティブを一時停止
      this.activeVideo.pause();

      // バッファ変数のスワップ
      const temp = this.activeVideo;
      this.activeVideo = this.inactiveVideo;
      this.inactiveVideo = temp;
      this.activeClipIndex = nextIndex;

      // さらにその次のクリップをプリロード
      this.preloadNextClip(nextIndex);
    }).catch(err => {
      console.error('Failed to switch video buffer:', err);
      // 失敗した場合はシークして再開を試みる
      this.activeClipIndex = nextIndex;
      this.activeVideo.src = nextClip.objectURL;
      this.activeVideo.currentTime = nextClip.start;
      this.activeVideo.play();
    });
  }

  destroy() {
    this.pause();
    this.videoA.remove();
    this.videoB.remove();
  }
}
