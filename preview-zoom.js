(function(global){
  "use strict";
  const MIN_SCALE=0.2,MAX_SCALE=4;
  const clamp=value=>Math.min(MAX_SCALE,Math.max(MIN_SCALE,value));

  function init(preview){
    if(!preview||preview.dataset.previewZoomActive)return null;
    const stage=preview.querySelector(".preview-zoom-stage");
    const content=preview.querySelector(".preview-zoom-content");
    const status=preview.querySelector("[data-preview-zoom-status]");
    if(!stage||!content)return null;
    let scale=1,pinch=null,frame=null;
    preview.dataset.previewZoomActive="true";

    function layout(){
      frame=null;
      if(global.matchMedia&&global.matchMedia("print").matches)return;
      const width=Math.ceil(content.offsetWidth*scale),height=Math.ceil(content.offsetHeight*scale);
      if(stage.style.width!==width+"px")stage.style.width=width+"px";
      if(stage.style.height!==height+"px")stage.style.height=height+"px";
      const transform="scale("+scale+")";
      if(content.style.transform!==transform)content.style.transform=transform;
      if(status)status.textContent=Math.round(scale*100)+"%";
    }
    function schedule(){if(frame===null)frame=global.requestAnimationFrame(layout);}
    function anchorAt(x,y){const rect=content.getBoundingClientRect();return {x:(x-rect.left)/scale,y:(y-rect.top)/scale};}
    function zoomAt(next,x,y,anchor){
      if(!Number.isFinite(next))return;
      anchor=anchor||anchorAt(x,y);
      scale=clamp(next);layout();
      const rect=content.getBoundingClientRect();
      preview.scrollLeft+=rect.left+anchor.x*scale-x;
      const dy=rect.top+anchor.y*scale-y;
      if(preview.scrollHeight>preview.clientHeight+1)preview.scrollTop+=dy;
      else if(global.document.scrollingElement)global.document.scrollingElement.scrollTop+=dy;
    }
    function touchesInside(event){return Array.from(event.touches||[]).filter(touch=>preview.contains(touch.target));}
    function pairInfo(touches){
      const a=touches[0],b=touches[1];
      return {distance:Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY),x:(a.clientX+b.clientX)/2,y:(a.clientY+b.clientY)/2};
    }
    function startPinch(touches){
      const info=pairInfo(touches);
      if(info.distance<1){pinch=null;return;}
      pinch={ids:touches.slice(0,2).map(touch=>touch.identifier),distance:info.distance,scale,anchor:anchorAt(info.x,info.y)};
    }
    function onTouchStart(event){
      const touches=touchesInside(event);
      if(touches.length<2)return;
      if(event.cancelable)event.preventDefault();
      if(!pinch)startPinch(touches);
    }
    function onTouchMove(event){
      const touches=touchesInside(event);
      if(touches.length<2){pinch=null;return;}
      if(event.cancelable)event.preventDefault();
      if(!pinch)startPinch(touches);
      if(!pinch)return;
      const pair=pinch.ids.map(id=>touches.find(touch=>touch.identifier===id));
      if(pair.some(touch=>!touch)){startPinch(touches);return;}
      const info=pairInfo(pair);
      zoomAt(pinch.scale*info.distance/pinch.distance,info.x,info.y,pinch.anchor);
    }
    function onTouchEnd(event){
      const touches=touchesInside(event);
      if(touches.length<2){pinch=null;return;}
      if(pinch&&pinch.ids.some(id=>!touches.some(touch=>touch.identifier===id)))startPinch(touches);
    }
    preview.addEventListener("wheel",event=>{
      if(!Number.isFinite(event.deltaY)||!event.deltaY)return;
      if(event.cancelable)event.preventDefault();
      const unit=event.deltaMode===1?16:event.deltaMode===2?preview.clientHeight:1;
      const delta=Math.max(-240,Math.min(240,event.deltaY*unit));
      zoomAt(scale*Math.exp(-delta*0.002),event.clientX,event.clientY);
    },{passive:false});
    preview.addEventListener("touchstart",onTouchStart,{passive:false});
    preview.addEventListener("touchmove",onTouchMove,{passive:false});
    preview.addEventListener("touchend",onTouchEnd,{passive:true});
    preview.addEventListener("touchcancel",()=>{pinch=null;},{passive:true});
    // Safari fires GestureEvents alongside TouchEvents. Suppress native page
    // zoom here, but change our scale only through the TouchEvent stream.
    for(const type of ["gesturestart","gesturechange","gestureend"]){
      preview.addEventListener(type,event=>{if(event.cancelable)event.preventDefault();},{passive:false});
    }
    global.addEventListener("resize",schedule);
    global.addEventListener("afterprint",schedule);
    if(global.ResizeObserver)new global.ResizeObserver(schedule).observe(content);
    else if(global.MutationObserver)new global.MutationObserver(schedule).observe(content,{childList:true,subtree:true,characterData:true,attributes:true});
    layout();
    return {getScale:()=>scale,refresh:layout};
  }

  function prepareExport(doc){
    // Modify only html2canvas's clone: the user's current zoom never flickers
    // or resets while the PDF is being generated.
    for(const preview of doc.querySelectorAll(".preview[data-preview-zoom-active]")){
      preview.removeAttribute("data-preview-zoom-active");
      preview.style.overflow="visible";
      preview.scrollLeft=0;preview.scrollTop=0;
    }
    for(const stage of doc.querySelectorAll(".preview-zoom-stage")){
      stage.style.width="1123px";stage.style.height="auto";stage.style.overflow="visible";
    }
    for(const content of doc.querySelectorAll(".preview-zoom-content")){
      content.style.transform="none";content.style.position="static";content.style.width="1123px";
    }
  }
  global.KKMTPreviewZoom={init,prepareExport};
  function start(){for(const preview of global.document.querySelectorAll(".preview"))init(preview);}
  if(global.document.readyState==="loading")global.document.addEventListener("DOMContentLoaded",start);
  else start();
})(window);
