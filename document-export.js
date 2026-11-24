(function(global){
  "use strict";
  const doc=global.document;
  const abortError=()=>Object.assign(new Error("出力を中止しました。"),{name:"AbortError"});
  const file=(blob,name)=>({blob,name,file:new File([blob],name,{type:blob.type})});
  function isMobile(){
    const nav=global.navigator||{},ua=nav.userAgent||"";
    if(nav.userAgentData&&nav.userAgentData.mobile===true)return true;
    if(/iPhone|iPad|iPod|Android|Mobile/i.test(ua))return true;
    return /Macintosh/.test(ua)&&nav.maxTouchPoints>1; // iPad in desktop mode
  }

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
      let snapshot,files=[],urls=[],cancelled=false,working=true,generating=true;
      const app=doc.querySelector(".app"),wasInert=app&&app.inert,focus=doc.activeElement;
      const check=()=>{if(cancelled)throw abortError();};
      dialog=doc.createElement("dialog");dialog.className="document-export";
      dialog.setAttribute("aria-labelledby","export-title");
      const heading=doc.createElement("h2");heading.id="export-title";heading.textContent=kind==="both"?"PDF・データの出力":kind==="pdf"?"PDFの出力":"データ（JSON）の出力";
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
        if(working&&!generating)return;
        if(working){cancelled=true;close.disabled=true;progress("中止処理中…");}
        else cleanup();
      };
      close.addEventListener("click",requestClose);
      dialog.addEventListener("cancel",event=>{event.preventDefault();requestClose();});
      const button=(label,action,parent=actions,primary=false)=>{
        const el=doc.createElement("button");el.type="button";el.textContent=label;if(primary)el.className="export-primary";parent.appendChild(el);
        el.run=async()=>{
          if(working)return;
          working=true;close.disabled=true;progress("保存・共有の操作中です…");
          const controls=Array.from(actions.querySelectorAll("button,a"));
          controls.forEach(node=>{node.disabled=true;node.setAttribute("aria-disabled","true");});
          try{await action();}
          catch(error){progress(error.name==="AbortError"?"キャンセルしました。作成済みファイルから再試行できます。":"保存・共有に失敗しました。下の個別保存から再試行してください。");}
          finally{working=false;close.disabled=false;controls.forEach(node=>{node.disabled=false;node.removeAttribute("aria-disabled");});}
        };
        el.addEventListener("click",el.run);return el;
      };
      const canShare=list=>{try{return !!(global.navigator.share&&global.navigator.canShare&&global.navigator.canShare({files:list.map(f=>f.file)}));}catch(_){return false;}};
      const labelOf=f=>f.name.endsWith(".pdf")?"PDF":"データ（JSON）";
      const mobile=isMobile();
      // PC (Chrome/Edge): save into a folder the user picks. The picker id makes the
      // browser reopen the last folder used for this document type.
      const pickerId=options.pickerId||"kkmt-documents";
      const pcFolder=!mobile&&typeof global.showDirectoryPicker==="function";
      const pcFile=!mobile&&typeof global.showSaveFilePicker==="function";
      const pickFolder=()=>global.showDirectoryPicker({id:pickerId,mode:"readwrite"});
      let folder=null,autoSaving=false;
      async function writeFile(handle,blob){
        let stream;
        try{stream=await handle.createWritable();await stream.write(blob);await stream.close();}
        catch(error){if(stream&&stream.abort)try{await stream.abort();}catch(_){}throw error;}
      }
      async function saveToFolder(directory){
        const existing=[];
        for(const f of files){try{await directory.getFileHandle(f.name);existing.push(f.name);}catch(_){}}
        if(existing.length&&!global.confirm(`「${directory.name}」フォルダーに同じ名前のファイルがあります。\n${existing.join("\n")}\n\n上書きしますか？`)){
          progress("保存を取りやめました。「別のフォルダーに保存」から保存先を選び直せます。");return false;
        }
        let saved=0;
        try{for(const f of files){await writeFile(await directory.getFileHandle(f.name,{create:true}),f.blob);saved++;}}
        catch(error){if(global.console)global.console.error("Folder save failed",error);progress(`${saved}／${files.length}件を保存しました。残りは「別のフォルダーに保存」か、下の「保存」から保存し直してください。`);return false;}
        progress(files.length>1?`「${directory.name}」フォルダーにPDFとデータの両方を保存しました。`:`「${directory.name}」フォルダーに保存しました。`);
        return true;
      }
      async function locked(task){
        working=true;close.disabled=true;
        const controls=Array.from(actions.querySelectorAll("button,a"));
        controls.forEach(node=>{node.disabled=true;node.setAttribute("aria-disabled","true");});
        try{return await task();}
        finally{working=false;close.disabled=false;controls.forEach(node=>{node.disabled=false;node.removeAttribute("aria-disabled");});}
      }
      function fileRow(f){
        const group=doc.createElement("section");group.className="export-file";
        const title=doc.createElement("h3");title.textContent=labelOf(f);
        const filename=doc.createElement("p");filename.className="export-filename";filename.textContent=f.name;
        const row=doc.createElement("div");row.className="export-file-actions";
        group.append(title,filename,row);actions.appendChild(group);
        return row;
      }
      function downloadLink(f,row,text){
        const label=labelOf(f);
        const link=doc.createElement("a");const url=global.URL.createObjectURL(f.blob);urls.push(url);
        link.href=url;link.download=f.name;link.textContent=text;link.setAttribute("aria-label",label+"をダウンロード");
        link.addEventListener("click",event=>{
          if(autoSaving)return;
          if(working){event.preventDefault();return;}
          progress(label+"のダウンロードを開始しました。端末でファイルを確認してください。");
        });row.appendChild(link);return link;
      }
      function ready(complete){
        const multiple=files.length>1;
        if(mobile){
          // Phones: hand the files to the share sheet (LINE, 「ファイルに保存」 etc.).
          const shareAll=canShare(files);
          let share=null;
          if(shareAll)share=button(multiple?"📤 共有（PDF・データ）":"📤 "+labelOf(files[0])+"を共有",async()=>{
            await global.navigator.share({files:files.map(f=>f.file),title:snapshot.name});
            progress(multiple?"共有メニューに両方のファイルを渡しました。送り先・保存先でファイルを確認してください。":"共有メニューに渡しました。送り先・保存先でファイルを確認してください。");
          },actions,true);
          const links=[];
          for(const f of files){
            const row=fileRow(f);
            if(shareAll&&canShare([f]))button("共有",async()=>{
              await global.navigator.share({files:[f.file],title:f.name});
              progress(labelOf(f)+"を共有メニューに渡しました。");
            },row);
            else links.push(downloadLink(f,row,"ダウンロード"));
          }
          if(!complete)return;
          if(shareAll){
            progress(multiple?"準備ができました。「共有」を押して、LINEや「ファイルに保存」などを選んでください。PDFだけ送るときはPDFの「共有」を押します。":"準備ができました。「共有」を押してください。");
            // When the original tap is still active the share sheet opens without a second tap.
            const activation=global.navigator.userActivation;
            if(activation&&activation.isActive)return share.run();
            return;
          }
          return autoDownload(links,multiple);
        }
        if(pcFolder)button(folder?"📂 別のフォルダーに保存":"📂 保存先フォルダーを選んで保存",async()=>{
          const directory=await pickFolder();
          folder=directory;await saveToFolder(directory);
        },actions,!folder);
        const links=[];
        for(const f of files){
          const row=fileRow(f);
          if(pcFile)button("保存",async()=>{
            const ext=f.name.endsWith(".pdf")?".pdf":".json";
            const handle=await global.showSaveFilePicker({id:pickerId,suggestedName:f.name,types:[{description:labelOf(f),accept:{[f.blob.type]:[ext]}}]});
            await writeFile(handle,f.blob);
            progress(labelOf(f)+"を保存しました。");
          },row);
          else links.push(downloadLink(f,row,"もう一度ダウンロード"));
        }
        if(!complete)return;
        if(folder)return locked(()=>saveToFolder(folder));
        if(pcFolder){progress("準備ができました。「保存先フォルダーを選んで保存」を押してください。");return;}
        // Browsers without folder access (Firefox, Safari): download as before.
        return autoDownload(links,multiple);
      }
      async function autoDownload(links,multiple){
        if(!links.length)return;
        working=true;close.disabled=true;autoSaving=true;
        try{
          for(let i=0;i<links.length;i++){
            if(i)await new Promise(resolve=>global.setTimeout(resolve,400));
            links[i].click();
          }
        }finally{autoSaving=false;working=false;close.disabled=false;}
        progress(multiple
          ?"PDF・データの両方をダウンロードしました。ダウンロードフォルダーを確認してください。「複数ファイルのダウンロード」の確認が出た場合は「許可」を押してください。"
          :"ダウンロードしました。ダウンロードフォルダーを確認してください。");
      }
      try{
        // Blur commits contenteditable/input changes before the atomic capture.
        if(focus&&focus.blur)focus.blur();
        if(app)app.inert=true;
        dialog.showModal();
        if(pcFolder){
          // Ask for the folder right away, while the click still counts as a user action.
          progress("保存先のフォルダーを選んでください（前回のフォルダーが最初に開きます）。");
          try{folder=await pickFolder();}
          catch(error){
            if(error&&error.name==="AbortError"){cancelled=true;cleanup();return;}
            folder=null;
          }
        }
        progress("入力内容を確認中…");
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
        check();generating=false;working=false;close.textContent="閉じる";await ready(true);
      }catch(error){
        if(cancelled){cleanup();return;}
        if(files.length){
          // Keep the frozen JSON recoverable even when PDF rendering fails.
          heading.textContent="PDF作成に失敗しました";
          ready(false);
          progress("PDFを作成できませんでした。"+(error.message||"")+" データ（JSON）は下から保存できます。PDFは閉じてから再実行してください。");
        }else progress(error.message||"作成に失敗しました。閉じてから再実行してください。");
      }finally{
        if(snapshot&&snapshot.dispose)snapshot.dispose();
        generating=false;working=false;busy=false;close.disabled=false;close.textContent="閉じる";
      }
    }
    return {start};
  }
  global.KKMTDocumentExport={create,capturePages,buildPdf,isMobile};
})(window);
