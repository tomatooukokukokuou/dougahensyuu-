/**
 * iPad向けタッチ操作対応タイムラインモジュール
 */
export class Timeline {
  constructor(scrollContainerEl, options = {}) {
    this.scrollContainer = scrollContainerEl;
    this.track = document.getElementById('timeline-track');
    this.ruler = document.getElementById('timeline-ruler');
    this.playhead = document.getElementById('playhead');

    this.options = {
      pxPerSec: 20, // 1秒あたりのピクセル幅
      onSeek: () => {},
      onClipSelect: () => {},
      onClipTrim: () => {},
      onClipsReorder: () => {},
      ...options
    };

    this.clips = [];
    this.selectedClipId = null;
    this.totalDuration = 0;
    this.isDraggingPlayhead = false;

    this.setupGlobalEvents();
  }

  /**
   * クリップデータの更新と再描画
   */
  setClips(clips, selectedClipId = null) {
    this.clips = clips;
    this.selectedClipId = selectedClipId;
    this.calculateTotalDuration();
    this.render();
  }

  calculateTotalDuration() {
    this.totalDuration = this.clips.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
  }

  /**
   * 再生ヘッドの位置更新 (秒単位)
   */
  updatePlayhead(virtualTime) {
    if (this.isDraggingPlayhead) return; // ドラッグ中は外部からの更新を無視
    
    const pxPerSec = this.options.pxPerSec;
    // タイムラインのpadding-left分 (40px) を考慮
    const leftPosition = 40 + (virtualTime * pxPerSec);
    this.playhead.style.left = `${leftPosition}px`;

    // 再生中、再生ヘッドが画面外に行きそうになったら自動スクロール
    this.autoScrollToPlayhead(leftPosition);
  }

  autoScrollToPlayhead(playheadLeft) {
    const containerWidth = this.scrollContainer.clientWidth;
    const scrollLeft = this.scrollContainer.scrollLeft;
    
    // ヘッドが右端の20%領域に入ったらスクロール
    if (playheadLeft > scrollLeft + containerWidth * 0.8) {
      this.scrollContainer.scrollLeft = playheadLeft - containerWidth * 0.5;
    }
    // 左端の10%領域に入ったら
    else if (playheadLeft < scrollLeft + containerWidth * 0.1) {
      this.scrollContainer.scrollLeft = Math.max(0, playheadLeft - containerWidth * 0.2);
    }
  }

  /**
   * タイムラインの全体再描画
   */
  render() {
    // 1. 古いクリップ要素をクリア (Playheadは残す)
    const clipElements = this.track.querySelectorAll('.timeline-clip');
    clipElements.forEach(el => el.remove());

    // トラックの幅を設定 (40px padding * 2)
    const trackWidth = 80 + (this.totalDuration * this.options.pxPerSec);
    this.track.style.width = `${Math.max(this.scrollContainer.clientWidth, trackWidth)}px`;

    // 2. クリップの描画
    this.clips.forEach((clip, index) => {
      const clipEl = this.createClipElement(clip, index);
      this.track.appendChild(clipEl);
    });

    // 3. 目盛りの描画
    this.renderRuler();
  }

  /**
   * クリップのHTML要素を生成
   */
  createClipElement(clip, index) {
    const pxPerSec = this.options.pxPerSec;
    const clipDuration = clip.end - clip.start;
    const width = clipDuration * pxPerSec;

    const clipEl = document.createElement('div');
    clipEl.className = 'timeline-clip';
    clipEl.dataset.id = clip.id;
    clipEl.dataset.index = index;
    clipEl.style.width = `${width}px`;

    if (clip.id === this.selectedClipId) {
      clipEl.classList.add('selected');
    }

    // サムネイル代わりのシマ模様 (CSS)
    const thumbnailStrip = document.createElement('div');
    thumbnailStrip.className = 'clip-thumbnail-strip';
    clipEl.appendChild(thumbnailStrip);

    // ラベル
    const label = document.createElement('div');
    label.className = 'clip-label';
    label.innerText = clip.name;
    clipEl.appendChild(label);

    // トリミングハンドル (左)
    const handleLeft = document.createElement('div');
    handleLeft.className = 'trim-handle trim-handle-left';
    clipEl.appendChild(handleLeft);

    // トリミングハンドル (右)
    const handleRight = document.createElement('div');
    handleRight.className = 'trim-handle trim-handle-right';
    clipEl.appendChild(handleRight);

    // イベント追加
    this.setupClipEvents(clipEl, clip, handleLeft, handleRight);

    return clipEl;
  }

  /**
   * 各クリップ内のタッチ・ドラッグ・トリムイベント設定
   */
  setupClipEvents(clipEl, clip, handleLeft, handleRight) {
    const pxPerSec = this.options.pxPerSec;

    // クリップ選択と並び替えドラッグ
    clipEl.addEventListener('pointerdown', (e) => {
      // トリムハンドルのタップはスルー
      if (e.target.classList.contains('trim-handle')) return;
      
      e.stopPropagation();
      this.options.onClipSelect(clip.id);

      // 並び替えドラッグ開始
      this.startReorderDrag(clipEl, clip, e);
    });

    // 左トリミングハンドルのドラッグ
    handleLeft.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      clipEl.releasePointerCapture(e.pointerId); // バブリング防止用
      
      const startX = e.clientX;
      const initialStart = clip.start;
      const maxStart = clip.end - 0.5; // 最小クリップ長 0.5秒

      const onPointerMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaSec = deltaX / pxPerSec;
        let newStart = initialStart + deltaSec;
        
        // 境界値制限 (0〜最大開始位置)
        newStart = Math.max(0, Math.min(newStart, maxStart));
        
        // リアルタイム反映 (プレビュー更新用)
        this.options.onClipTrim(clip.id, newStart, clip.end, true); // true = 調整中(ドラッグ中)
      };

      const onPointerUp = () => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        this.options.onClipTrim(clip.id, clip.start, clip.end, false); // 調整完了
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });

    // 右トリミングハンドルのドラッグ
    handleRight.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      
      const startX = e.clientX;
      const initialEnd = clip.end;
      const minEnd = clip.start + 0.5; // 最小クリップ長 0.5秒
      const maxEnd = clip.duration; // オリジナル動画の長さまで

      const onPointerMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaSec = deltaX / pxPerSec;
        let newEnd = initialEnd + deltaSec;
        
        newEnd = Math.max(minEnd, Math.min(newEnd, maxEnd));
        
        this.options.onClipTrim(clip.id, clip.start, newEnd, true);
      };

      const onPointerUp = () => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        this.options.onClipTrim(clip.id, clip.start, clip.end, false);
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });
  }

  /**
   * 並び替えドラッグロジック
   */
  startReorderDrag(clipEl, clip, downEvent) {
    const pxPerSec = this.options.pxPerSec;
    const startX = downEvent.clientX;
    const initialIndex = parseInt(clipEl.dataset.index);
    
    let isDragging = false;
    let dragPlaceholder = null;
    let ghostEl = null;
    
    // クリップの初期左オフセット（親トラックに対する相対位置）
    const initialLeft = clipEl.offsetLeft;

    const onPointerMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      
      // 最初は10px以上動かさないとドラッグ開始とみなさない (誤動作防止)
      if (!isDragging && Math.abs(deltaX) > 10) {
        isDragging = true;
        clipEl.classList.add('dragging');

        // プレースホルダー（隙間の点線枠）を作成して挿入
        dragPlaceholder = document.createElement('div');
        dragPlaceholder.className = 'timeline-clip';
        dragPlaceholder.style.width = clipEl.style.width;
        dragPlaceholder.style.border = '2px dashed var(--accent-color)';
        dragPlaceholder.style.background = 'transparent';
        dragPlaceholder.style.borderRadius = '12px';
        dragPlaceholder.style.marginRight = '2px';
        dragPlaceholder.style.flexShrink = '0';
        
        // 元のクリップのすぐ隣に挿入
        clipEl.parentNode.insertBefore(dragPlaceholder, clipEl);
        
        // ドラッグ中のゴースト要素
        clipEl.style.position = 'absolute';
        clipEl.style.zIndex = '100';
        clipEl.style.pointerEvents = 'none';
        clipEl.style.left = `${initialLeft}px`;
      }

      if (isDragging) {
        // ゴースト要素の位置更新
        const currentLeft = initialLeft + deltaX;
        clipEl.style.left = `${currentLeft}px`;

        // プレースホルダーの移動判定 (並び順のシミュレート)
        const trackClips = Array.from(this.track.querySelectorAll('.timeline-clip:not(.dragging)'));
        
        // ゴースト要素の中心座標
        const ghostCenter = currentLeft + (clipEl.offsetWidth / 2);
        
        let newIndex = 0;
        let found = false;

        for (let i = 0; i < trackClips.length; i++) {
          const item = trackClips[i];
          // プレースホルダー自身は除外して比較
          if (item === dragPlaceholder) continue;

          const itemCenter = item.offsetLeft + (item.offsetWidth / 2);
          if (ghostCenter < itemCenter) {
            this.track.insertBefore(dragPlaceholder, item);
            found = true;
            break;
          }
        }

        // 一番右端の場合
        if (!found && trackClips.length > 0) {
          this.track.appendChild(dragPlaceholder);
        }
      }
    };

    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      if (isDragging) {
        clipEl.classList.remove('dragging');
        clipEl.style.position = '';
        clipEl.style.zIndex = '';
        clipEl.style.left = '';
        clipEl.style.pointerEvents = '';

        // プレースホルダーの最終位置からインデックスを取得
        const children = Array.from(this.track.querySelectorAll('.timeline-clip'));
        const finalIndex = children.indexOf(dragPlaceholder);
        
        dragPlaceholder.remove();

        // 配列の並び替えを実行
        if (finalIndex !== -1 && finalIndex !== initialIndex) {
          const updatedClips = [...this.clips];
          const [removed] = updatedClips.splice(initialIndex, 1);
          
          // プレースホルダーを除去した後のインデックス補正
          let targetIndex = finalIndex;
          if (finalIndex > initialIndex) {
            targetIndex -= 1; // 自身が抜けた分詰まるため
          }
          
          updatedClips.splice(targetIndex, 0, removed);
          this.options.onClipsReorder(updatedClips);
        } else {
          // 移動しなかった場合は再描画して元に戻す
          this.render();
        }
      }
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  /**
   * シーク操作などのタイムライン全体イベント
   */
  setupGlobalEvents() {
    const handleSeek = (clientX) => {
      const rect = this.track.getBoundingClientRect();
      const relativeX = clientX - rect.left - 40; // padding-left 40px分を引く
      const pxPerSec = this.options.pxPerSec;
      
      let seekTime = relativeX / pxPerSec;
      seekTime = Math.max(0, Math.min(seekTime, this.totalDuration));
      
      this.options.onSeek(seekTime);
    };

    // トラック全体のクリック・タッチでシーク
    this.track.addEventListener('pointerdown', (e) => {
      // クリップ自体やトリミングハンドルのクリックは除外
      if (e.target !== this.track && e.target !== this.playhead) return;
      
      this.isDraggingPlayhead = true;
      handleSeek(e.clientX);

      const onPointerMove = (moveEvent) => {
        handleSeek(moveEvent.clientX);
      };

      const onPointerUp = () => {
        this.isDraggingPlayhead = false;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });
  }

  /**
   * ルーラー（時間軸）の描画
   */
  renderRuler() {
    this.ruler.innerHTML = '';
    const pxPerSec = this.options.pxPerSec;
    
    // ルーラーの横幅を設定 (Timeline-trackと同期)
    const rulerWidth = 80 + (this.totalDuration * pxPerSec);
    this.ruler.style.width = `${Math.max(this.scrollContainer.clientWidth, rulerWidth)}px`;

    // 5秒おきに大目盛り、1秒おきに小目盛り
    const step = 1; // 1秒刻み
    const totalSec = Math.ceil(this.totalDuration) + 5; // 余裕を持たせる

    for (let sec = 0; sec <= totalSec; sec += step) {
      const left = 40 + (sec * pxPerSec);
      
      const tick = document.createElement('div');
      tick.style.left = `${left}px`;
      
      if (sec % 5 === 0) {
        tick.className = 'ruler-tick major';
        
        // ラベル (分:秒)
        const label = document.createElement('span');
        label.className = 'ruler-label';
        label.style.left = `${left}px`;
        
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = (sec % 60).toString().padStart(2, '0');
        label.innerText = `${m}:${s}`;
        
        this.ruler.appendChild(label);
      } else {
        tick.className = 'ruler-tick minor';
      }
      
      this.ruler.appendChild(tick);
    }
  }
}
