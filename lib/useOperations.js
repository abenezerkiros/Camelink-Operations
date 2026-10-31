'use client';
import {useEffect,useMemo,useState} from 'react';
import {collection,limit,onSnapshot,orderBy,query} from 'firebase/firestore';
import {firebase,friendlyError} from './firebase';
import {mapRecords} from './live-model';
const names=['customers','customerShipments','operationsShipments','drivers','trucks','driverLocations','auditLogs'];
export function useOperations(uid){const [raw,setRaw]=useState(null),[error,setError]=useState(''),[online,setOnline]=useState(true),[cached,setCached]=useState(false),[now,setNow]=useState(Date.now()),[retry,setRetry]=useState(0),[capped,setCapped]=useState(false);
 useEffect(()=>{const tick=setInterval(()=>setNow(Date.now()),15000);const update=()=>setOnline(navigator.onLine);update();window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{clearInterval(tick);window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 useEffect(()=>{let alive=true,failed=false;setRaw(null);setError('');setCapped(false);const data={},cache={},full={};const stops=names.map(name=>{let q=query(collection(firebase().db,name),limit(2000));if(name==='customerShipments')q=query(collection(firebase().db,name),orderBy('createdAt','desc'),limit(2000));if(name==='auditLogs')q=query(collection(firebase().db,name),orderBy('at','desc'),limit(500));return onSnapshot(q,{includeMetadataChanges:true},snap=>{if(!alive||failed)return;data[name]=snap.docs.map(d=>({...d.data(),id:d.id}));cache[name]=snap.metadata.fromCache;full[name]=snap.size===(name==='auditLogs'?500:2000);if(names.every(n=>data[n])){setRaw({...data});setCached(Object.values(cache).some(Boolean));setCapped(names.some(n=>n!=='auditLogs'&&full[n]));}},e=>{if(!alive)return;failed=true;setError(`${name}: ${friendlyError(e)}`);setRaw(null);});});return()=>{alive=false;stops.forEach(f=>f());};},[uid,retry]);
 const state=useMemo(()=>raw?mapRecords(raw,now):null,[raw,now]);return{state,error,online,cached,capped,reconnect:()=>setRetry(x=>x+1)};
}
