(function(global){
  "use strict";
  const doc=global.document;
  const abortError=()=>Object.assign(new Error("出力を中止しました。"),{name:"AbortError"});
  const file=(blob,name)=>({blob,name,file:new File([blob],name,{type:blob.type})});

  // Keep IDs/styles but isolate the snapshot from live form selectors and updates.
  // No preview ancestors means screen zoom never changes the PDF dimensions.
  function capturePages(elements){
    const frame=doc.createElement("iframe");
    frame.title="PDF作成用"; frame.setAttribute("aria-hidden","true");
    frame.style.cssText="position:fixed;left:-20000px;top:0;width:1123px;height:800px;border:0;pointer-events:none";
    doc.body.appendChild(frame);
    try{
      const target=frame.contentDocument;
      target.open();
      target.write('<!doctype html><html lang="ja"><head><meta charset="UTF-8"></head><body></body></html>');
      target.close();
      for(const style of doc.querySelectorAll("style"))target.head.appendChild(style.cloneNode(true));
      target.body.style.cssText="margin:0;background:white;width:1123px;height:auto";
      const extra=target.createElement("div");extra.id="sheetExtra";
      target.body.appendChild(extra);
      const pages=elements.map(element=>{
        const copy=element.cloneNode(true);
        copy.style.transform="none";copy.style.zoom="1";copy.style.margin="0";
        copy.querySelectorAll("[contenteditable]").forEach(el=>el.setAttribute("contenteditable","false"));
        const sources=element.querySelectorAll("canvas");
        copy.querySelectorAll("canvas").forEach((canvas,i)=>canvas.getContext("2d").drawImage(sources[i],0,0));
        if(element.classList.contains("cont"))extra.appendChild(copy);
        else target.body.insertBefore(copy,extra);
        return copy;
      });
      return {pages,dispose:()=>frame.remove()};
    }catch(error){frame.remove();throw error;}
  }

  async function buildPdf(snapshot,progress,check=()=>{}){
    if(!(global.html2canvas&&global.jspdf))throw new Error("PDF部品を読み込めません。ページを開き直してください。");
    const pdf=new global.jspdf.jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
    const pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight(),m=5;
    for(let i=0;i<snapshot.pages.length;i++){
      check();progress(`PDF作成中：${i+1}／${snapshot.pages.length}ページ`);
      const page=snapshot.pages[i];
      // Fail explicitly on missing images instead of silently omitting a signature.
      await Promise.all(Array.from(page.querySelectorAll("img"),img=>new Promise((resolve,reject)=>{
        if(img.complete)return img.naturalWidth?resolve():reject(new Error("画像を読み込めません。サイン・画像を確認してください。"));
        const timer=setTimeout(()=>finish(new Error("画像の読み込みが時間切れになりました。")),10000);
        function finish(error){clearTimeout(timer);img.onload=img.onerror=null;error?reject(error):resolve();}
        img.onload=()=>finish();img.onerror=()=>finish(new Error("画像を読み込めません。サイン・画像を確認してください。"));
      })));
      check();
      let timer;
      const rendering=global.html2canvas(page,{scale:2,backgroundColor:"#ffffff",useCORS:true,
        ignoreElements:el=>el.classList&&el.classList.contains("rowdel"),
        onclone:doc=>{check();if(global.KKMTPreviewZoom)global.KKMTPreviewZoom.prepareExport(doc);}});
      let canvas;
      try{canvas=await Promise.race([rendering,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error("PDF作成が時間切れになりました。閉じてから再実行してください。")),30000);
      })]);}finally{clearTimeout(timer);}
      check();
      let w=pw-2*m,h=w/(canvas.width/canvas.height);
      if(h>ph-2*m){h=ph-2*m;w=h*canvas.width/canvas.height;}
      if(i)pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/jpeg",snapshot.quality||0.95),"JPEG",m+(pw-2*m-w)/2,m,w,h);
      canvas.width=canvas.height=0;
    }
    return file(pdf.output("blob"),snapshot.name+".pdf");
  }

  function create(options){
    let busy=false,dialog=null;
    async function start(kind){
      if(busy||dialog)return;
      busy=true;
      let snapshot,files=[],urls=[],cancelled=false,working=true;
      const app=doc.querySelector(".app"),wasInert=app&&app.inert,focus=doc.activeElement;
      const check=()=>{if(cancelled)throw abortError();};
      dialog=doc.createElement("dialog");dialog.className="document-export";
      dialog.setAttribute("aria-labelledby","export-title");
      const heading=doc.createElement("h2");heading.id="export-title";heading.textContent="保存・共有";
      const status=doc.createElement("p");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
      const actions=doc.createElement("div");actions.className="export-actions";
      const close=doc.createElement("button");close.type="button";close.textContent="中止";
      dialog.append(heading,status,actions,close);doc.body.appendChild(dialog);
      const progress=text=>{status.textContent=text;};
      const cleanup=()=>{
        urls.forEach(url=>global.URL.revokeObjectURL(url));urls=[];
        if(dialog){dialog.remove();dialog=null;}
        if(app)app.inert=wasInert;
        busy=false;
        if(focus&&focus.focus)focus.focus();
      };
      const requestClose=()=>{
        if(working){cancelled=true;close.disabled=true;progress("中止処理中…");}
        else cleanup();
      };
      close.addEventListener("click",requestClose);
      dialog.addEventListener("cancel",event=>{event.preventDefault();requestClose();});
      const button=(label,action)=>{
        const el=doc.createElement("button");el.type="button";el.textContent=label;actions.appendChild(el);
        el.addEventListener("click",async()=>{
          if(working)return;
          working=true;close.disabled=true;
          const controls=Array.from(actions.querySelectorAll("button,a"));
          controls.forEach(node=>{node.disabled=true;node.setAttribute("aria-disabled","true");});
          try{await action();}
          catch(error){progress(error.name==="AbortError"?"キャンセルしました。作成済みファイルから再試行できます。":"保存・共有に失敗しました。下の個別保存から再試行してください。");}
          finally{working=false;close.disabled=false;controls.forEach(node=>{node.disabled=false;node.removeAttribute("aria-disabled");});}
        });return el;
      };
      const canShare=list=>{try{return !!(global.navigator.share&&global.navigator.canShare&&global.navigator.canShare({files:list.map(f=>f.file)}));}catch(_){return false;}};
      async function write(handle,blob){
        let stream;
        try{stream=await handle.createWritable();await stream.write(blob);await stream.close();}
        catch(error){if(stream&&stream.abort)try{await stream.abort();}catch(_){}throw error;}
      }
      function ready(){
        const pc=options.isPC();
        if(!pc&&canShare(files))button(files.length>1?"PDF・JSONをまとめて共有":"ファイルを共有",async()=>{
          await global.navigator.share({files:files.map(f=>f.file),title:snapshot.name});
          progress("共有先に渡しました。共有先でファイルを確認してください。");
        });
        if(pc&&files.length>1&&global.showDirectoryPicker)button("同じフォルダーに両方保存",async()=>{
          const directory=await global.showDirectoryPicker({mode:"readwrite"});
          let saved=0;
          try{for(const f of files){await write(await directory.getFileHandle(f.name,{create:true}),f.blob);saved++;}}
          catch(error){progress(`${saved}／${files.length}件を保存しました。保存できなかったファイルは下から個別に保存してください。`);return;}
          progress("PDF・JSONの両方を保存しました。");
        });
        for(const f of files){
          const label=f.name.endsWith(".pdf")?"PDF":"JSONデータ";
          if(pc&&global.showSaveFilePicker)button(label+"の保存先を選ぶ",async()=>{
            const ext=f.name.endsWith(".pdf")?".pdf":".json";
            const handle=await global.showSaveFilePicker({suggestedName:f.name,types:[{description:label,accept:{[f.blob.type]:[ext]}}]});
            await write(handle,f.blob);progress(label+"を保存しました。");
          });
          else if(!pc&&canShare([f])&&files.length>1)button(label+"を共有",async()=>{
            await global.navigator.share({files:[f.file],title:f.name});progress(label+"を共有先に渡しました。");
          });
          // One genuine user gesture per file: never chain downloads or open popups.
          const link=doc.createElement("a");const url=global.URL.createObjectURL(f.blob);urls.push(url);
          link.href=url;link.download=f.name;link.textContent=label+"を保存";
          link.addEventListener("click",event=>{
            if(working){event.preventDefault();return;}
            progress(label+"の保存を開始しました。端末のダウンロードを確認してください。");
          });actions.appendChild(link);
        }
        progress(files.length>1?"PDF・JSONの準備ができました。同時共有が使えない場合は、両方を個別に保存してください。":"準備ができました。保存または共有してください。");
      }
      try{
        // Blur commits contenteditable/input changes before the atomic capture.
        if(focus&&focus.blur)focus.blur();
        if(app)app.inert=true;
        dialog.showModal();progress("入力内容を確認中…");
        if(options.beforeCapture){
          let timer;
          try{await Promise.race([options.beforeCapture(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("入力の準備が時間切れになりました。もう一度お試しください。")),10000);})]);}
          finally{clearTimeout(timer);}
        }
        check();snapshot=options.capture(kind);
        // Do not await between state, filename and page capture in adapters.
        snapshot.state=JSON.parse(JSON.stringify(snapshot.state));
        if(kind!=="pdf")files.push(file(new Blob([JSON.stringify(snapshot.state,null,2)],{type:"application/json"}),snapshot.name+".json"));
        if(kind!=="json")files.unshift(await buildPdf(snapshot,progress,check));
        check();ready();
      }catch(error){
        if(cancelled){cleanup();return;}
        progress(error.message||"作成に失敗しました。閉じてから再実行してください。");
      }finally{
        if(snapshot&&snapshot.dispose)snapshot.dispose();
        working=false;busy=false;close.disabled=false;close.textContent="閉じる";
      }
    }
    return {start};
  }
  global.KKMTDocumentExport={create,capturePages,buildPdf};
})(window);
