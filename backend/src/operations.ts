import {getApps,initializeApp} from 'firebase-admin/app';
import {getFirestore, type Transaction, type DocumentReference} from 'firebase-admin/firestore';
import {onCall,HttpsError,type CallableRequest} from 'firebase-functions/v2/https';
import {createHash,randomUUID} from 'node:crypto';
import {requireOperator} from './operator-auth';
import {validateCargo, type Shipment, type Status, STATUSES} from '../../shared/contracts';
import type {DriverProfile, DriverTrip} from '../../shared/driver';
if(!getApps().length) initializeApp();
const db=getFirestore(), opts={region:'europe-west1',maxInstances:10};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fail(s:string):never{throw new HttpsError('failed-precondition',s);}
function id(v:unknown):string{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v))throw new HttpsError('invalid-argument','Invalid record ID.');return v;}
function text(v:unknown,max=100):string{if(typeof v!=='string'||!v.trim()||v.length>max)throw new HttpsError('invalid-argument',`Enter text between 1 and ${max} characters.`);return v.trim();}
function cargo(v:unknown){try{return validateCargo(v);}catch{throw new HttpsError('invalid-argument','Invalid cargo details.');}}
function unchanged(value:any,expected:unknown){if(typeof expected!=='number'||(value.updatedAt||0)!==expected)throw new HttpsError('aborted','This record changed. Close the panel, refresh and try again.');}
function open(s:Shipment|undefined):asserts s is Shipment{if(!s)fail('Shipment not found.');if(['delivered','cancelled'].includes(s.status))fail('This shipment is closed.');}
function event(status:Status){return{id:randomUUID(),status,at:Date.now()};}
async function command(r:CallableRequest,action:string,work:(tx:Transaction,actor:string)=>Promise<any>){
 const actor=await requireOperator(r),requestId=id(r.data?.requestId),ref=db.doc(`operatorCommands/${actor}_${requestId}`);
 // Request hash prevents a retry ID being reused for a different command.
 const fingerprint=hash(JSON.stringify({action,data:r.data}));
 return db.runTransaction(async tx=>{
  const op=(await tx.get(db.doc(`operators/${actor}`))).data();if(op?.enabled!==true)throw new HttpsError('permission-denied','Operator access revoked.');
  const old=(await tx.get(ref)).data();if(old){if(old.fingerprint!==fingerprint)fail('Request ID already used.');return old.result;}
  const result=await work(tx,actor);tx.create(ref,{fingerprint,result,actor,action,at:Date.now()});return result;
 });
}
function audit(tx:Transaction,actor:string,action:string,details:Record<string,unknown>){tx.create(db.collection('auditLogs').doc(),{actor,action,...details,at:Date.now()});}
export const operatorCreateShipment=onCall(opts,async r=>{
 const customerId=id(r.data?.customerId), shipmentId=id(r.data?.requestId),data=cargo(r.data?.cargo);
 return command(r,'shipment.created',async(tx,actor)=>{
  const c=(await tx.get(db.doc(`customers/${customerId}`))).data();if(!c?.fullName)fail('Choose an existing customer with a completed profile.');
  const sr=db.doc(`customerShipments/${shipmentId}`);if((await tx.get(sr)).exists)fail('Shipment ID already exists.');
  const now=Date.now(),s:Shipment={id:shipmentId,reference:'CML-'+shipmentId.toUpperCase(),customerId,cargo:data,status:'awaiting_review',createdAt:now,updatedAt:now,events:[{id:'created',status:'awaiting_review',at:now}]};
  tx.create(sr,s);tx.create(db.doc(`operationsShipments/${shipmentId}`),{shipmentId,customerId,driverId:null,truckId:null,createdAt:now,createdBy:actor});
  audit(tx,actor,'shipment.created_by_operator',{shipmentId,customerId});return{id:shipmentId};
 });
});
export const operatorEditShipment=onCall(opts,async r=>{
 const shipmentId=id(r.data?.shipmentId),data=cargo(r.data?.cargo),reason=text(r.data?.reason,1000);
 return command(r,'shipment.corrected',async(tx,actor)=>{
  const sr=db.doc(`customerShipments/${shipmentId}`),tr=db.doc(`driverTrips/${shipmentId}`),s=(await tx.get(sr)).data() as Shipment|undefined,t=await tx.get(tr);open(s);unchanged(s,r.data.expectedUpdatedAt);
  const now=Date.now();tx.update(sr,{cargo:data,updatedAt:now});if(t.exists)tx.update(tr,{cargo:data,updatedAt:now});
  audit(tx,actor,'shipment.corrected',{shipmentId,reason,before:s.cargo,after:data});return{id:shipmentId};
 });
});
export const operatorUpdateMilestone=onCall(opts,async r=>{
 const shipmentId=id(r.data?.shipmentId),status=r.data?.status as Status,reason=text(r.data?.reason,1000);
 if(!STATUSES.includes(status)||['awaiting_review','cancelled'].includes(status))throw new HttpsError('invalid-argument','Choose a trip milestone.');
 return command(r,'shipment.milestone',async(tx,actor)=>{
  const sr=db.doc(`customerShipments/${shipmentId}`),tr=db.doc(`driverTrips/${shipmentId}`),s=(await tx.get(sr)).data() as Shipment|undefined,t=(await tx.get(tr)).data() as DriverTrip|undefined;open(s);unchanged(s,r.data.expectedUpdatedAt);
  if(!t||t.status!==s.status)fail('Assign a driver before updating milestones.');if(s.status===status)fail('That milestone is already current.');
  const pr=db.doc(`drivers/${t.driverId}`),p=(await tx.get(pr)).data();if(p?.activeTripId!==shipmentId)fail('Driver assignment has changed.');
  const e=event(status);tx.update(sr,{status,updatedAt:e.at,events:[...s.events,e]});tx.update(tr,{status,updatedAt:e.at,events:[...t.events,e]});
  if(status==='delivered')tx.update(pr,{activeTripId:null,online:true});
  audit(tx,actor,'shipment.milestone',{shipmentId,reason,before:s.status,after:status});return{id:shipmentId};
 });
});
export const operatorReassignTrip=onCall(opts,async r=>{
 const shipmentId=id(r.data?.shipmentId),driverId=id(r.data?.driverId),reason=text(r.data?.reason,1000);
 if(r.data?.phoneConfirmed!==true)fail('Confirm the handover with both drivers by phone.');
 return command(r,'trip.reassigned',async(tx,actor)=>{
  const sr=db.doc(`customerShipments/${shipmentId}`),tr=db.doc(`driverTrips/${shipmentId}`),pr=db.doc(`drivers/${driverId}`);
  const s=(await tx.get(sr)).data() as Shipment|undefined,t=(await tx.get(tr)).data() as DriverTrip|undefined,p=(await tx.get(pr)).data() as DriverProfile|undefined;
  open(s);unchanged(s,r.data.expectedUpdatedAt);if(!t||t.status!==s.status||s.status==='awaiting_review')fail('Only an assigned active trip can be reassigned.');
  if(!p?.enabled||!p.online||p.activeTripId||p.uid===t.driverId)fail('Choose another available driver.');
  const truck=(await tx.get(db.doc(`trucks/${p.truckId}`))).data(),loc=(await tx.get(db.doc(`driverLocations/${driverId}`))).data(),oldRef=db.doc(`drivers/${t.driverId}`),old=(await tx.get(oldRef)).data();
  if(old?.activeTripId!==shipmentId)fail('Previous driver assignment has changed.');
  if(!truck?.approved||truck.driverId!==driverId)fail('Truck is not approved for this driver.');
  if(!loc?.online||![loc.receivedAt,loc.recordedAt].every(v=>Number.isFinite(v)&&v<=Date.now()+60000&&Date.now()-v<=180000))fail('Location is stale. Ask the driver to restore tracking.');
  const now=Date.now(),archiveId=`${shipmentId}_${r.data.requestId}`;
  // Keep the prior driver's cancelled assignment in their history. The current trip ID belongs only to the new driver.
  tx.create(db.doc(`driverTrips/${archiveId}`),{...t,id:archiveId,originalShipmentId:shipmentId,reassigned:true,status:'cancelled',updatedAt:now,events:[...t.events,event('cancelled')]});
  tx.update(tr,{driverId,truckId:p.truckId,updatedAt:now});tx.update(sr,{updatedAt:now});
  tx.update(pr,{activeTripId:shipmentId});tx.update(oldRef,{activeTripId:null});
  tx.set(db.doc(`operationsShipments/${shipmentId}`),{driverId,truckId:p.truckId,assignedBy:actor,assignedAt:now},{merge:true});
  audit(tx,actor,'trip.reassigned',{shipmentId,reason,previousDriverId:t.driverId,driverId});return{id:shipmentId};
 });
});
export const operatorUpdateDriver=onCall(opts,async r=>{
 const driverId=id(r.data?.driverId),fullName=text(r.data?.fullName),truckPlate=text(r.data?.truckPlate),truckType=text(r.data?.truckType),capacity=text(r.data?.capacity),reason=text(r.data?.reason,1000);
 if(typeof r.data?.approved!=='boolean')throw new HttpsError('invalid-argument','Specify truck approval.');
 return command(r,'driver.updated',async(tx,actor)=>{
  const pr=db.doc(`drivers/${driverId}`),p=(await tx.get(pr)).data() as (DriverProfile&{updatedAt?:number})|undefined;if(!p)fail('Driver not found.');if(p.activeTripId)fail('Resolve the active trip before changing the driver or truck.');unchanged(p,r.data.expectedUpdatedAt);
  // Phone stays immutable: Auth phone and OTP lookup must not diverge.
  if(r.data.phone&&r.data.phone!==p.phone)fail('The registered phone number cannot be changed in this form.');
  const truckId=hash(truckPlate.toUpperCase()),newRef=db.doc(`trucks/${truckId}`),newTruck=(await tx.get(newRef)).data();
  if(newTruck&&newTruck.driverId!==driverId)fail('This truck is registered to another driver.');
  const now=Date.now(),changes={fullName,truckId,truckPlate,truckType,capacity,updatedAt:now,online:truckId===p.truckId&&r.data.approved?p.online:false};
  tx.update(pr,changes);if(truckId!==p.truckId)tx.set(db.doc(`trucks/${p.truckId}`),{approved:false,driverId:null,updatedAt:now},{merge:true});
  tx.set(newRef,{id:truckId,driverId,plate:truckPlate,approved:r.data.approved,approvedBy:actor,approvedAt:now});
  if(!changes.online)tx.set(db.doc(`driverLocations/${driverId}`),{online:false},{merge:true});
  audit(tx,actor,'driver.updated',{driverId,reason,before:{fullName:p.fullName,truckId:p.truckId,truckPlate:p.truckPlate,truckType:p.truckType,capacity:p.capacity},after:changes,approved:r.data.approved});return{id:driverId};
 });
});
export const operatorSetDriverEnabled=onCall(opts,async r=>{
 const driverId=id(r.data?.driverId),enabled=r.data?.enabled,reason=text(r.data?.reason,1000);if(typeof enabled!=='boolean')throw new HttpsError('invalid-argument','Specify enabled state.');
 return command(r,'driver.access',async(tx,actor)=>{
  const ref=db.doc(`drivers/${driverId}`),p=(await tx.get(ref)).data();if(!p)fail('Driver not found.');if(p.activeTripId)fail('Resolve the active trip before changing access.');unchanged(p,r.data.expectedUpdatedAt);
  tx.update(ref,{enabled,online:false,updatedAt:Date.now()});tx.set(db.doc(`driverLocations/${driverId}`),{online:false},{merge:true});audit(tx,actor,enabled?'driver.enabled':'driver.suspended',{driverId,reason});return{id:driverId};
 });
});
