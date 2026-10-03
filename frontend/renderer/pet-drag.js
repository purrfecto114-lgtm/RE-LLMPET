'use strict';

// R60: drag owner — pointer gesture → window move queue, extracted from
// pet.js per the R60-1 blueprint. Keeps this project's Tauri-specific
// machinery (rAF frame coalescing + serialized IPC chain + commit-on-drop,
// which upstream Electron's startDragging cannot provide) and ports the
// four upstream v1.2.0 pet.js:3910-4025 defenses the audit found missing:
//   * gesture identity — stale async IPC results check `g === gesture`
//     (already present, kept explicit);
//   * buttons self-heal — a transparent window can LOSE the pointerup
//     (WebView2/GTK focus steal); if a move arrives with no button held,
//     the gesture finishes itself instead of sticking to the cursor;
//   * lostpointercapture — finishes the gesture (kept);
//   * click-restore — a pure click re-applies the last committed position
//     (Bug 5 fix, kept).
(function (root) {
  function create(deps) {
    const d = deps || {};
    const api = d.api;                 // window.pet (setWinPos/commitWinPos/getWinPos)
    const log = d.log || (() => {});
    const perfNow = d.perfNow || (() => Date.now());
    const setMouseIgnore = d.setMouseIgnore || (() => {});
    const getWinPosCache = d.getWinPosCache || (() => null);
    const onPureClick = d.onPureClick || (() => {});
    const onDragStart = d.onDragStart || (() => {});

    let g = null;              // active gesture: {el,pid,sx,sy,cx,cy,moved,win}
    let dragFrame = 0;
    let pendingDragPos = null;
    let dragMoveChain = Promise.resolve();
    let lastWinPos = getWinPosCache();

    function setCachedPos(pos) { lastWinPos = pos; if (d.onPosCached) d.onPosCached(pos); }
    function getCachedPos() { return lastWinPos; }

    function queueWindowMove(x, y) {
      pendingDragPos = [Math.round(x), Math.round(y)];
      if (dragFrame) return;
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        const pos = pendingDragPos;
        pendingDragPos = null;
        if (!pos) return;
        dragMoveChain = dragMoveChain
          .catch(() => {})
          .then(() => api.setWinPos(pos[0], pos[1]))
          .catch((error) => log('drag', 'move failed: ' + String(error && error.message || error || 'unknown')));
        setCachedPos(pos);
      });
    }

    function flushWindowMove() {
      if (dragFrame) {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      const pos = pendingDragPos;
      pendingDragPos = null;
      if (pos) {
        dragMoveChain = dragMoveChain
          .catch(() => {})
          .then(() => api.setWinPos(pos[0], pos[1]))
          .catch((error) => log('drag', 'move failed: ' + String(error && error.message || error || 'unknown')));
        setCachedPos(pos);
      }
    }

    function commitWindowMove() {
      flushWindowMove();
      dragMoveChain = dragMoveChain
        .catch(() => {})
        .then(() => api.commitWinPos())
        .then(([wx, wy]) => { setCachedPos([wx, wy]); })
        .catch((error) => log('drag', 'commit failed: ' + String(error && error.message || error || 'unknown')));
    }

    function finishGesture(gesture, allowClick) {
      if (!gesture) return;
      if (g === gesture) g = null;
      try { gesture.el.releasePointerCapture(gesture.pid); } catch {}
      gesture.el.classList.remove('dragging');
      // Bug 5 fix: 纯点击后恢复保存的坐标（防止 Windows 钳制离屏位置）
      if (!gesture.moved && lastWinPos) {
        api.setWinPos(lastWinPos[0], lastWinPos[1]).catch(() => {});
      }
      // Re-enable native hit-test ownership after the gesture. `true` means the
      // transparent regions may ignore input again; the native guard still keeps
      // the window interactive while the cursor is over the pet or an open HUD.
      setMouseIgnore(true);
      if (gesture.moved) commitWindowMove();
      else if (allowClick) onPureClick();
    }

    function attachDrag(el) {
      el.addEventListener('pointerdown', (e) => {
        // Windows may deliver contextmenu after pointerdown while transparent
        // regions are click-through. Claim input here so the right-click reaches
        // the radial-menu toggle instead of the application below the pet.
        if (e.button === 2) {
          e.preventDefault();
          setMouseIgnore(false);
          // R50: toggling here (not in contextmenu) because preventDefault() on
          // pointerdown suppresses the compatibility mouse pipeline — including
          // contextmenu — on several WebView builds. contextmenu below is kept as
          // a guarded fallback for builds that fire it.
          d.onRightClickPointer(e);
          return;
        }
        if (e.button !== 0) return;
        e.preventDefault();
        // R35.1: a drag start cancels any pending radial open — the user has
        // switched intent from "click to open HUD" to "drag the pet".
        onDragStart();
        // Bug 5 fix: 延迟关闭穿透，等确认拖动后再关闭
        // setMouseIgnore(false) 移到 pointermove 中阈值超过后执行
        try { el.setPointerCapture(e.pointerId); } catch {}
        el.classList.add('dragging');
        g = {
          el, pid: e.pointerId, sx: e.screenX, sy: e.screenY, cx: e.screenX, cy: e.screenY, moved: false, win: lastWinPos,
        };
        const gesture = g;
        api.getWinPos().then(([wx, wy]) => {
          if (g !== gesture) return; // gesture 身份校验：过期 IPC 不得覆盖新手势
          gesture.win = [wx, wy];
          setCachedPos([wx, wy]);
          if (gesture.moved) queueWindowMove(wx + gesture.cx - gesture.sx, wy + gesture.cy - gesture.sy);
        }).catch(() => {});
      });

      el.addEventListener('pointermove', (e) => {
        const gesture = g;
        if (!gesture || gesture.pid !== e.pointerId) return;
        // Upstream defense (v1.2.0): buttons self-heal. A transparent window can
        // lose the pointerup entirely (focus steal / click-through transitions);
        // a move with NO button held is treated as the lost pointerup.
        if (e.buttons === 0 && gesture.moved) {
          finishGesture(gesture, false);
          return;
        }
        gesture.cx = e.screenX;
        gesture.cy = e.screenY;
        const dx = gesture.cx - gesture.sx;
        const dy = gesture.cy - gesture.sy;
        const dragThreshold = e.pointerType === 'touch' ? 10 : 4;
        if (!gesture.moved && Math.abs(dx) + Math.abs(dy) > dragThreshold) {
          gesture.moved = true;
          setMouseIgnore(false);  // Bug 5 fix: 确认拖动后才关闭穿透
          d.onDragConfirmed();
        }
        if (gesture.moved && gesture.win) {
          queueWindowMove(gesture.win[0] + dx, gesture.win[1] + dy);
        }
      });

      el.addEventListener('pointerup', (e) => {
        const gesture = g;
        if (!gesture || gesture.pid !== e.pointerId) return;
        finishGesture(gesture, true);
      });
      el.addEventListener('pointercancel', () => finishGesture(g, false));
      el.addEventListener('lostpointercapture', () => { if (g) finishGesture(g, false); });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setMouseIgnore(false);
        // R50: pointerdown(button 2) already toggled on builds that suppress
        // contextmenu; skip if that just happened, otherwise toggle here for
        // builds that deliver contextmenu without a prior pointerdown claim.
        d.onContextMenuFallback(e);
      });
    }

    function isDragging() { return !!g; }
    function dispose() {
      flushWindowMove();
      g = null;
    }

    return Object.freeze({
      attachDrag, queueWindowMove, flushWindowMove, commitWindowMove,
      setCachedPos, getCachedPos, isDragging, dispose,
    });
  }

  root.OctoPetDrag = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
