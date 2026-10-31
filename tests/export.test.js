import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shipmentCSV} from '../lib/export.js';
test('CSV escapes quotes, line breaks and spreadsheet formulas',()=>{const csv=shipmentCSV([{reference:'CLK-1',customerId:'c',driverId:null,status:'awaiting_review',cargo:{itemLoaded:'=1+1',itemQuantity:'5',departure:'A,"B"',destination:'City\nTwo'}}],[{id:'c',fullName:'Test Customer'}],[],{awaiting_review:'Awaiting review'});assert.ok(csv.includes('"\'=1+1"'));assert.ok(csv.includes('"A,""B"""'));assert.ok(csv.includes('"City\nTwo"'));});
