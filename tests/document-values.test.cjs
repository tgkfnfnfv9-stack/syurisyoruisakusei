const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function validator(file,name){
 const html=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
 const a=html.indexOf('function '+name+'('),b=html.indexOf('\n}',a)+2;
 const context={initialFieldValues:{client:'',b1_use:false,sameAsSite:true},isValidSignatureData:value=>value===''||typeof value==='string'&&/^data:image\//.test(value)};
 vm.createContext(context);vm.runInContext(html.slice(a,b),context);return context[name];
}
for(const [file,name,type] of [['見積書.html','validateEstimateState','estimate'],['報告書メーカー.html','validateReportState','report'],['報告書メーカー.html','validateImportedEstimate','estimate']]){
 const validate=validator(file,name),state=()=>({documentType:type,fields:{client:'入力会社',b1_use:false},parts:[],customs:[],lodges:[],wdays:[],work:[]});
 assert.doesNotThrow(()=>validate(state()));
 for(const bad of [{nested:true},['会社'],Infinity]){
  const s=state();s.fields.client=bad;assert.throws(()=>validate(s),/値形式/);
  for(const [array,key] of [['parts','name'],['parts','excl'],['customs','amt'],['lodges','people'],['wdays','hours']]){
   const s=state();s[array]=[{[key]:bad}];assert.throws(()=>validate(s),/値形式/);
  }
 }
 const checked=state();checked.fields.b1_use='false';assert.throws(()=>validate(checked),/チェック/);
 const holiday=state();holiday.lodges=[{holiday:'false'}];assert.throws(()=>validate(holiday),/休日/);
 const zero=state();zero.parts=[{cost:800,excl:0,qty:0}];assert.doesNotThrow(()=>validate(zero));
 if(type==='report'){
  for(const inactivePeople of [[null],[{worker:'作業者',hours:{value:3}}],[{worker:'作業者',hours:Infinity}],{}]){
   const s=state();s.work=[{inactivePeople}];assert.throws(()=>validate(s),/作業者/);
  }
  const good=state();good.work=[{people:[{worker:'',hours:'0.5'}],inactivePeople:[{worker:'退避者',hours:3.5}]}];assert.doesNotThrow(()=>validate(good));
  const signature=state();signature.signature=0;assert.throws(()=>validate(signature),/サイン/);
 }
}
console.log('Document value validation checks passed.');
