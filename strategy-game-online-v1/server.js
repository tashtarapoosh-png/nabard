const express = require("express");
const path = require("path");
const { randomUUID, scryptSync, timingSafeEqual } = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json({limit:"1mb"}));

const PORT = process.env.PORT || 3000;
const ARRIVAL_SECONDS = Number(process.env.ARRIVAL_SECONDS || 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const names = {
  archer: "کماندار",
  cavalry: "سواره‌نظام",
  swordsman: "شمشیرزن"
};

const emptyArmy = () => ({ archer: 100, cavalry: 100, swordsman: 100 });
const emptyDefense = () => Array.from({length:6},()=>({type:"",count:0}));

function hashPassword(password){
  const salt=randomUUID().replace(/-/g,'');
  return salt+':'+scryptSync(String(password),salt,64).toString('hex');
}
function verifyPassword(password,stored){
  if(!stored||!stored.includes(':'))return false;
  const [salt,hash]=stored.split(':');
  const actual=scryptSync(String(password),salt,64);
  const expected=Buffer.from(hash,'hex');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function defaultBuildings(){return {castle:{level:1},wall:{level:1},barracks1:{level:1},barracks2:{level:1},goldMine:{level:1}};}
function randomDefense(){
  const slots=emptyDefense(),types=['archer','cavalry','swordsman'];
  const n=2+Math.floor(Math.random()*5);
  for(let i=0;i<n;i++)slots[i]={type:types[Math.floor(Math.random()*types.length)],count:1+Math.floor(Math.random()*100)};
  return slots;
}

async function initDb(){
  if(!process.env.DATABASE_URL){
    throw new Error("DATABASE_URL تنظیم نشده است.");
  }

  // هر دستور SQL جداگانه اجرا می‌شود تا pg آن را به prepared statement معتبر تبدیل کند.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS castles (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      army JSONB NOT NULL,
      defense_slots JSONB NOT NULL,
      under_attack BOOLEAN NOT NULL DEFAULT FALSE,
      battle_id INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attacks (
      id BIGSERIAL PRIMARY KEY,
      attacker_id INTEGER NOT NULL REFERENCES castles(id),
      target_id INTEGER NOT NULL REFERENCES castles(id),
      army_side TEXT NOT NULL,
      attacker_slots JSONB NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrives_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS battles (
      id BIGSERIAL PRIMARY KEY,
      target_id INTEGER NOT NULL UNIQUE REFERENCES castles(id),
      defender_slots JSONB NOT NULL,
      armies JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '100 years'),
      ended BOOLEAN NOT NULL DEFAULT FALSE,
      winner_side TEXT,
      report_armies JSONB NOT NULL DEFAULT '[]'::jsonb,
      round_number INTEGER NOT NULL DEFAULT 0,
      round_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      round_duration_seconds INTEGER NOT NULL DEFAULT 20
    )
  `);

  await pool.query(`
    ALTER TABLE battles ADD COLUMN IF NOT EXISTS report_armies JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS round_number INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS round_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS round_duration_seconds INTEGER NOT NULL DEFAULT 20`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS round_claim_token TEXT`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS round_claim_expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS processed_round_number INTEGER NOT NULL DEFAULT 0`);
  // ساعت نبرد با پایان راند جلو می‌رود و به ورود/خروج بازیکنان وابسته نیست.
  await pool.query(`UPDATE battles SET ends_at=NOW()+INTERVAL '100 years' WHERE ended=FALSE`);
  await pool.query(`UPDATE battles SET round_duration_seconds=20 WHERE ended=FALSE AND round_duration_seconds<>20`);
  await pool.query(`UPDATE battles SET round_number=1, processed_round_number=0, round_started_at=NOW(), round_duration_seconds=20 WHERE ended=FALSE AND round_number=0`);
  await pool.query(`UPDATE battles SET processed_round_number=round_number WHERE ended=FALSE AND processed_round_number=0 AND round_number>1`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS battle_reports (
      id BIGSERIAL PRIMARY KEY,
      battle_id BIGINT NOT NULL UNIQUE,
      report JSONB NOT NULL,
      winner_side TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // حساب کاربری، مختصات ثابت نقشه و داده‌های توسعه قلعه در همان رکورد قلعه نگهداری می‌شوند.
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS map_x INTEGER`);
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS map_y INTEGER`);
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS gold BIGINT NOT NULL DEFAULT 3000`);
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS buildings JSONB NOT NULL DEFAULT '{"castle":{"level":1},"wall":{"level":1},"barracks1":{"level":1},"barracks2":{"level":1},"goldMine":{"level":1}}'::jsonb`);
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS battle_history JSONB NOT NULL DEFAULT '[]'::jsonb`);

  // تبدیل یک‌بارهٔ قلعه‌های آزمایشی قدیمی به چهار حساب پیش‌فرض موردنیاز.
  const legacy=await pool.query("SELECT COUNT(*)::int AS n FROM castles WHERE username IS NOT NULL");
  if(Number(legacy.rows[0].n)===0){
    await pool.query("TRUNCATE TABLE battle_reports, attacks, battles, castles RESTART IDENTITY CASCADE");
    const defaults=[
      {id:1,username:'jahan1',x:-2,y:2},
      {id:2,username:'jahan2',x:2,y:2},
      {id:3,username:'jahan3',x:-2,y:-2},
      {id:4,username:'jahan4',x:2,y:-2}
    ];
    for(const c of defaults){
      const slots=emptyDefense(); const types=['archer','cavalry','swordsman'];
      const n=2+Math.floor(Math.random()*5);
      for(let i=0;i<n;i++)slots[i]={type:types[Math.floor(Math.random()*types.length)],count:1+Math.floor(Math.random()*100)};
      await pool.query(`INSERT INTO castles(id,name,army,defense_slots,username,password_hash,map_x,map_y,gold,buildings)
        VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,3000,$9::jsonb)`,
        [c.id,'قلعه '+c.id,JSON.stringify(emptyArmy()),JSON.stringify(slots),c.username,hashPassword('1234'),c.x,c.y,JSON.stringify(defaultBuildings())]);
    }
  } else {
    await pool.query("INSERT INTO castles(id,name,army,defense_slots,username,password_hash,map_x,map_y) SELECT x,'قلعه '||x,$1::jsonb,$2::jsonb,'jahan'||x,$3,NULL,NULL FROM generate_series(1,4) x ON CONFLICT(id) DO NOTHING",[JSON.stringify(emptyArmy()),JSON.stringify(emptyDefense()),hashPassword('1234')]);
  }

  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS under_attack BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE castles ADD COLUMN IF NOT EXISTS battle_id BIGINT`);
  await pool.query(`ALTER TABLE castles ALTER COLUMN battle_id TYPE BIGINT`);

  await pool.query(`
    ALTER TABLE battles
    ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ
  `);
  await pool.query(`
    UPDATE battles
    SET ends_at = created_at + INTERVAL '100 years'
    WHERE ends_at IS NULL
  `);
  await pool.query(`
    ALTER TABLE battles
    ALTER COLUMN ends_at SET DEFAULT (NOW() + INTERVAL '100 years')
  `);
  await pool.query(`
    ALTER TABLE battles
    ALTER COLUMN ends_at SET NOT NULL
  `);
}

function normalizeSlots(slots){
  return (Array.isArray(slots)?slots:[])
    .map(s=>({
      type:String(s?.type||""),
      count:Math.max(0,Math.floor(Number(s?.count)||0))
    }))
    .filter(s=>names[s.type] && s.count>0)
    .slice(0,6);
}

function cellXY(cell){
  return {
    x:Number(cell.slice(1))-1,
    y:"ABCDEFGHIJKLMNOPQRST".indexOf(cell[0])
  };
}

const blocks = {
  "مدافع":[
    ["D4","D5","D6","E4","E5","E6"],
    ["D7","D8","D9","E7","E8","E9"],
    ["D1","D2","D3","E1","E2","E3"],
    ["D10","D11","D12","E10","E11","E12"]
  ],
  "مهاجم":[
    ["P4","P5","P6","Q4","Q5","Q6"],
    ["P7","P8","P9","Q7","Q8","Q9"],
    ["P1","P2","P3","Q1","Q2","Q3"],
    ["P10","P11","P12","Q10","Q11","Q12"]
  ]
};

function makeArmy(side, castleId, slots, blockIndex, armyId){
  const block=blocks[side]?.[blockIndex];
  if(!block)return null;
  const normalized=normalizeSlots(slots);
  const units=normalized.map((slot,index)=>{
    const cell=block[index];
    const pos=cellXY(cell);
    return {
      id:String(armyId)+"-unit-"+(index+1),
      type:names[slot.type],
      rawType:slot.type,
      count:slot.count,
      initialCount:slot.count,
      castle:Number(castleId),
      side,
      x:pos.x,
      y:pos.y,
      cell,
      health:slot.count*(slot.type==="archer"?500:1000)
    };
  });
  return {
    armyId:String(armyId),
    castleId:Number(castleId),
    side,
    blockIndex,
    slots:normalized,
    units
  };
}

function publicCastle(row){
  return {
    id:row.id,
    name:row.name,
    army:row.army,
    defenseSlots:row.defense_slots,
    underAttack:row.under_attack,
    battleId:row.battle_id,
    username:row.username||null,
    mapX:row.map_x,
    mapY:row.map_y,
    gold:Number(row.gold||0),
    buildings:row.buildings||defaultBuildings()
  };
}

async function getCastles(client=pool){
  const r=await client.query("SELECT * FROM castles ORDER BY id");
  return r.rows.map(publicCastle);
}

async function getBattleByTarget(targetId, client=pool){
  const r=await client.query(
    "SELECT * FROM battles WHERE target_id=$1 AND ended=FALSE",
    [targetId]
  );
  if(!r.rows[0])return null;
  const b=r.rows[0];
  return {
    batId:Number(b.id),
    targetId:Number(b.target_id),
    defenderSlots:b.defender_slots,
    armies:b.armies,
    createdAt:new Date(b.created_at).getTime(),
    endsAt:new Date(b.ends_at).getTime(),
    roundNumber:Number(b.round_number||0),
    roundStartedAt:new Date(b.round_started_at||b.created_at).getTime(),
    roundDurationSeconds:Number(b.round_duration_seconds||20),
    roundSecondsRemaining:Math.max(0,Math.ceil((new Date(b.round_started_at||b.created_at).getTime()+Number(b.round_duration_seconds||20)*1000-Date.now())/1000)),
    ended:b.ended,
    winnerSide:b.winner_side,
    reportArmies:b.report_armies
  };
}

function battleJson(row){
  if(!row)return null;
  return {
    batId:Number(row.id),
    targetId:Number(row.target_id),
    defenderSlots:row.defender_slots,
    armies:row.armies,
    createdAt:new Date(row.created_at).getTime(),
    endsAt:new Date(row.ends_at).getTime(),
    roundNumber:Number(row.round_number||0),
    roundStartedAt:new Date(row.round_started_at||row.created_at).getTime(),
    roundDurationSeconds:Number(row.round_duration_seconds||20),
    roundSecondsRemaining:Math.max(0,Math.ceil((new Date(row.round_started_at||row.created_at).getTime()+Number(row.round_duration_seconds||20)*1000-Date.now())/1000)),
    ended:row.ended,
    winnerSide:row.winner_side,
    reportArmies:row.report_armies
  };
}

async function expireBattles(){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const r=await client.query(`
      SELECT id,target_id FROM battles
      WHERE ended=FALSE AND ends_at<=NOW()
      FOR UPDATE
    `);
    for(const b of r.rows){
      await client.query('DELETE FROM attacks WHERE target_id=$1 AND status=\'resolved\'', [b.target_id]);
      await client.query('DELETE FROM battles WHERE id=$1', [b.id]);
      await client.query(
        'UPDATE castles SET under_attack=FALSE,battle_id=NULL WHERE id=$1 AND battle_id=$2',
        [b.target_id,b.id]
      );
    }
    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{client.release();}
}

async function currentBattleForCastle(castleId){
  const r=await pool.query(`
    SELECT b.*
    FROM battles b
    WHERE b.ended=FALSE
      AND (
        b.target_id=$1
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(b.armies) a
          WHERE (a->>'castleId')::int=$1
        )
      )
    ORDER BY b.id DESC
    LIMIT 1
  `,[castleId]);
  return battleJson(r.rows[0]);
}

// ذخیره مقصد انتخاب‌شده برای یک واحد. حرکت واقعی فقط در پایان راند انجام می‌شود.
app.put("/api/battle/:id/move", async (req,res)=>{
  const battleId=Number(req.params.id);
  const unitId=String(req.body?.unitId||"");
  const destination=String(req.body?.destination||"").toUpperCase();
  const castleId=Number(req.body?.castleId);
  const rowMatch=/^([A-T])(1[0-2]|[1-9])$/.exec(destination);

  if(!Number.isInteger(battleId)||!unitId||!rowMatch||!Number.isInteger(castleId))
    return res.status(400).json({error:"اطلاعات حرکت نامعتبر است."});

  const x=Number(rowMatch[2])-1;
  const y="ABCDEFGHIJKLMNOPQRST".indexOf(rowMatch[1]);
  if(x<0||x>11||y<0||y>19)
    return res.status(400).json({error:"خانه مقصد نامعتبر است."});

  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query(
      "SELECT * FROM battles WHERE id=$1 AND ended=FALSE AND ends_at>NOW() FOR UPDATE",
      [battleId]
    );
    if(!r.rows[0]){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    }

    const battle=r.rows[0];
    const armies=Array.isArray(battle.armies)?battle.armies:[];
    let found=null;
    for(const army of armies){
      for(const unit of (army.units||[])){
        if(String(unit.id)===unitId){ found={army,unit}; break; }
      }
      if(found)break;
    }

    if(!found){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"واحد نیرو در این نبرد پیدا نشد."});
    }
    if(Number(found.army.castleId)!==castleId){
      await client.query("ROLLBACK");
      return res.status(403).json({error:"این واحد متعلق به این قلعه نیست."});
    }

    // فقط مقصد ذخیره می‌شود؛ x/y/cell در پایان راند تغییر می‌کنند.
    found.unit.moveTarget=destination;

    const updated=await client.query(
      "UPDATE battles SET armies=$1::jsonb, report_armies=$2::jsonb WHERE id=$3 AND ended=FALSE AND ends_at>NOW() RETURNING *",
      [JSON.stringify(armies),JSON.stringify(mergeReportArmies(battle.report_armies,armies)),battleId]
    );
    await client.query("COMMIT");
    res.json({ok:true,battle:battleJson(updated.rows[0])});
  }catch(e){
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({error:"ذخیره مقصد حرکت ناموفق بود."});
  }finally{client.release();}
});

// پایان راند: مقصدهای ذخیره‌شده در SQL به cell/x/y تبدیل می‌شوند.
app.put("/api/battle/:id/apply-round-moves", async (req,res)=>{
  const battleId=Number(req.params.id);
  if(!Number.isInteger(battleId))
    return res.status(400).json({error:"شماره نبرد نامعتبر است."});

  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query(
      "SELECT * FROM battles WHERE id=$1 AND ended=FALSE AND ends_at>NOW() FOR UPDATE",
      [battleId]
    );
    if(!r.rows[0]){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    }

    const battle=r.rows[0];
    const armies=Array.isArray(battle.armies)?battle.armies:[];
    let moved=0;
    for(const army of armies){
      for(const unit of (army.units||[])){
        // هر واحد فقط یک بار در هر شماره راند می‌تواند حرکت کند.
        const currentRound=Number(battle.round_number||0);
        if(unit.movedRound!==undefined && unit.movedRound!==null && Number(unit.movedRound)>=currentRound)continue;
        const destination=String(unit.moveTarget||"").toUpperCase();
        const m=/^([A-T])(1[0-2]|[1-9])$/.exec(destination);
        if(!m)continue;
        const x=Number(m[2])-1;
        const y="ABCDEFGHIJKLMNOPQRST".indexOf(m[1]);
        if(x<0||x>11||y<0||y>19)continue;
        unit.cell=destination;
        unit.x=x;
        unit.y=y;
        unit.movedRound=currentRound;
        delete unit.moveTarget;
        moved++;
      }
    }

    const updated=await client.query(
      "UPDATE battles SET armies=$1::jsonb, report_armies=$2::jsonb WHERE id=$3 AND ended=FALSE AND ends_at>NOW() RETURNING *",
      [JSON.stringify(armies),JSON.stringify(mergeReportArmies(battle.report_armies,armies)),battleId]
    );
    await client.query("COMMIT");
    res.json({ok:true,moved,battle:battleJson(updated.rows[0])});
  }catch(e){
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({error:"اعمال حرکت‌های راند ناموفق بود."});
  }finally{client.release();}
});

app.get("/api/battle/:id/state", async (req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id))return res.status(400).json({error:"شماره نبرد نامعتبر است."});
  try{
    const r=await pool.query(
      "SELECT * FROM battles WHERE id=$1 AND ended=FALSE AND ends_at>NOW()",
      [id]
    );
    if(!r.rows[0])return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    res.json({ok:true,battle:battleJson(r.rows[0])});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"خواندن وضعیت نبرد ناموفق بود."});
  }
});

// ساعت راند فقط در SQL جلو می‌رود؛ بازیکن آنلاین یا تایمر مرورگر برای تیک‌زدن لازم نیست.
async function advanceBattleRoundClocks(){
  await pool.query(`
    UPDATE battles
    SET round_number = round_number + FLOOR(EXTRACT(EPOCH FROM (NOW()-round_started_at)) / round_duration_seconds)::int,
        round_started_at = round_started_at + (FLOOR(EXTRACT(EPOCH FROM (NOW()-round_started_at)) / round_duration_seconds)::int * round_duration_seconds) * INTERVAL '1 second'
    WHERE ended=FALSE
      AND round_duration_seconds=20
      AND round_started_at + round_duration_seconds * INTERVAL '1 second' <= NOW()
  `);
}

// پاسخ ساعت، شماره راند و زمان سرور را از PostgreSQL می‌گیرد.
app.get("/api/battle/:id/round", async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id))return res.status(400).json({error:"شماره نبرد نامعتبر است."});
  try{
    const r=await pool.query(
      `SELECT round_number, round_started_at, round_duration_seconds,
              round_claim_token, round_claim_expires_at, processed_round_number,
              (EXTRACT(EPOCH FROM (round_started_at + round_duration_seconds * INTERVAL '1 second'))*1000)::bigint AS round_ends_at_ms,
              (EXTRACT(EPOCH FROM NOW())*1000)::bigint AS server_now_ms
       FROM battles WHERE id=$1 AND ended=FALSE`,
      [id]
    );
    if(!r.rows[0])return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    const row=r.rows[0];
    res.json({ok:true,roundNumber:Number(row.round_number||0),processedRoundNumber:Number(row.processed_round_number||0),roundEndsAt:Number(row.round_ends_at_ms),serverNow:Number(row.server_now_ms)});
  }catch(e){
    console.error("read round clock",e);
    res.status(500).json({error:"خواندن زمان راند از SQL ناموفق بود."});
  }
});

// تنها یک کلاینت در هر لحظه می‌تواند منطق بازیِ راند ثبت‌شده را اجرا کند؛ این قفل ساعت را جلو نمی‌برد.
app.post("/api/battle/:id/round/claim", async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id))return res.status(400).json({error:"شماره نبرد نامعتبر است."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query(`SELECT * FROM battles WHERE id=$1 AND ended=FALSE FOR UPDATE`,[id]);
    if(!q.rows[0]){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    }
    const row=q.rows[0];
    const roundEndsAt=new Date(row.round_started_at).getTime()+Number(row.round_duration_seconds)*1000;
    const claimExpires=row.round_claim_expires_at ? new Date(row.round_claim_expires_at).getTime() : 0;
    if(Number(row.round_number||0)<=Number(row.processed_round_number||0)){
      await client.query("COMMIT");
      return res.json({ok:true,claimed:false,roundNumber:Number(row.round_number||0),roundEndsAt});
    }
    if(row.round_claim_token && claimExpires>Date.now()){
      await client.query("COMMIT");
      return res.json({ok:true,claimed:false,roundNumber:Number(row.round_number||0),roundEndsAt});
    }
    const token=randomUUID();
    const claimed=await client.query(
      `UPDATE battles SET round_claim_token=$1, round_claim_expires_at=NOW()+INTERVAL '120 seconds'
       WHERE id=$2 AND ended=FALSE
       RETURNING round_number, round_started_at, round_duration_seconds, round_claim_expires_at`,
      [token,id]
    );
    const saved=claimed.rows[0];
    await client.query("COMMIT");
    res.json({ok:true,claimed:true,token,roundNumber:Number(saved.round_number||0),roundEndsAt:new Date(saved.round_started_at).getTime()+Number(saved.round_duration_seconds)*1000});
  }catch(e){
    try{await client.query("ROLLBACK");}catch(rollbackError){console.error("rollback round claim",rollbackError);}
    console.error("round-claim",e);
    res.status(500).json({error:"گرفتن قفل راند در SQL ناموفق بود."});
  }finally{client.release();}
});

// ثبت پردازش راند، بدون تغییر ساعت و شماره راندی که PostgreSQL به‌طور مستقل جلو برده است.
app.post("/api/battle/:id/round/commit", async(req,res)=>{
  const id=Number(req.params.id);
  const token=String(req.body?.token||"");
  if(!Number.isInteger(id)||!token)return res.status(400).json({error:"اطلاعات ثبت راند نامعتبر است."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query(`SELECT * FROM battles WHERE id=$1 AND ended=FALSE FOR UPDATE`,[id]);
    if(!q.rows[0]){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    }
    const row=q.rows[0];
    const expires=row.round_claim_expires_at ? new Date(row.round_claim_expires_at).getTime() : 0;
    if(row.round_claim_token!==token || expires<=Date.now()){
      await client.query("ROLLBACK");
      return res.status(409).json({error:"قفل این راند معتبر نیست یا منقضی شده است؛ وضعیت راند را دوباره بخوانید."});
    }
    const updated=await client.query(
      `UPDATE battles
       SET processed_round_number=GREATEST(processed_round_number,round_number),
           round_number=round_number+1,
           round_started_at=round_started_at + round_duration_seconds * INTERVAL '1 second',
           round_claim_token=NULL, round_claim_expires_at=NULL
       WHERE id=$1 AND ended=FALSE
       RETURNING round_number, processed_round_number, round_started_at, round_duration_seconds`,[id]
    );
    const saved=updated.rows[0];
    await client.query("COMMIT");
    res.json({ok:true,roundNumber:Number(saved.round_number||0),processedRoundNumber:Number(saved.processed_round_number||0),roundEndsAt:new Date(saved.round_started_at).getTime()+Number(saved.round_duration_seconds)*1000});
  }catch(e){
    try{await client.query("ROLLBACK");}catch(rollbackError){console.error("rollback round commit",rollbackError);}
    console.error("round-commit",e);
    res.status(500).json({error:"ثبت پردازش راند در SQL ناموفق بود."});
  }finally{client.release();}
});

app.put("/api/battle/:id/state", async (req,res)=>{
  const id=Number(req.params.id);
  const armies=Array.isArray(req.body?.armies)?req.body.armies:null;
  if(!Number.isInteger(id)||!armies)return res.status(400).json({error:"اطلاعات وضعیت نبرد نامعتبر است."});

  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const current=await client.query(
      "SELECT * FROM battles WHERE id=$1 AND ended=FALSE AND ends_at>NOW() FOR UPDATE",
      [id]
    );
    if(!current.rows[0]){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    }
    const row=current.rows[0];
    const reportArmies=mergeReportArmies(row.report_armies,armies);
    const saved=await client.query(
      `UPDATE battles
       SET armies=$1::jsonb, report_armies=$2::jsonb
       WHERE id=$3 AND ended=FALSE AND ends_at>NOW()
       RETURNING *`,
      [JSON.stringify(armies),JSON.stringify(reportArmies),id]
    );
    if(!saved.rows[0]){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    }
    await client.query("COMMIT");
    res.json({ok:true,battle:battleJson(saved.rows[0])});
  }catch(e){
    try{await client.query("ROLLBACK");}catch(rollbackError){console.error("rollback battle state",rollbackError);}
    console.error(e);
    res.status(500).json({error:"ذخیره موقعیت نیروها ناموفق بود."});
  }finally{client.release();}
});

app.get("/api/battle-reports", async(req,res)=>{
  try{
    const r=await pool.query(`
      SELECT id,battle_id,winner_side,created_at
      FROM battle_reports
      ORDER BY battle_id DESC
    `);
    res.json({ok:true,reports:r.rows.map(x=>({
      id:Number(x.id),
      battleId:Number(x.battle_id),
      winnerSide:x.winner_side,
      createdAt:new Date(x.created_at).getTime()
    }))});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"خواندن گزارش‌های نبرد ناموفق بود."});
  }
});

app.get("/api/battle-reports/:id", async(req,res)=>{
  const battleId=Number(req.params.id);
  if(!Number.isInteger(battleId))return res.status(400).json({error:"شماره نبرد نامعتبر است."});
  try{
    const r=await pool.query(
      `SELECT battle_id,report,winner_side,created_at FROM battle_reports WHERE battle_id=$1`,
      [battleId]
    );
    if(!r.rows[0])return res.status(404).json({error:"گزارش این نبرد پیدا نشد."});
    res.json({
      ok:true,
      battleId:Number(r.rows[0].battle_id),
      report:Array.isArray(r.rows[0].report)?r.rows[0].report:[],
      winnerSide:r.rows[0].winner_side,
      createdAt:new Date(r.rows[0].created_at).getTime()
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"خواندن گزارش نبرد ناموفق بود."});
  }
});

app.delete("/api/battle-reports", async(req,res)=>{
  try{
    const r=await pool.query("DELETE FROM battle_reports");
    res.json({ok:true,deleted:Number(r.rowCount||0)});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"پاک کردن گزارش‌های نبرد ناموفق بود."});
  }
});

// پاک‌سازی کامل اطلاعات قبلی بازی و ساخت دوباره قلعه‌ها از صفر.
// ثبت‌نام/ورود؛ شماره قلعه جدید در تراکنش و با قفل جدول افزایشی تخصیص داده می‌شود.
app.post('/api/auth/login',async(req,res)=>{
  try{
    const username=String(req.body.username||'').trim();
    const password=String(req.body.password||'');
    const q=await pool.query('SELECT * FROM castles WHERE LOWER(username)=LOWER($1)',[username]);
    const row=q.rows[0];
    if(!row||!verifyPassword(password,row.password_hash))return res.status(401).json({error:'نام کاربری یا رمز عبور نادرست است.'});
    res.json({ok:true,castle:publicCastle(row)});
  }catch(e){console.error('login',e);res.status(500).json({error:'ورود انجام نشد.'});}
});
app.post('/api/auth/register',async(req,res)=>{
  const username=String(req.body.username||'').trim();
  const password=String(req.body.password||'');
  if(!/^[a-zA-Z0-9_]{3,24}$/.test(username))return res.status(400).json({error:'نام کاربری باید ۳ تا ۲۴ حرف انگلیسی، عدد یا زیرخط باشد.'});
  if(password.length<4||password.length>100)return res.status(400).json({error:'رمز عبور باید حداقل ۴ نویسه داشته باشد.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('LOCK TABLE castles IN EXCLUSIVE MODE');
    const exists=await client.query('SELECT 1 FROM castles WHERE LOWER(username)=LOWER($1)',[username]);
    if(exists.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'این نام کاربری قبلاً ثبت شده است.'});}
    const maxq=await client.query('SELECT COALESCE(MAX(id),0)::int AS max_id FROM castles');
    const id=Number(maxq.rows[0].max_id)+1;
    // مختصات از حلقه‌های مارپیچی بیرون از محدودهٔ چهار قلعهٔ اولیه انتخاب می‌شود و ثابت می‌ماند.
    const usedQ=await client.query('SELECT map_x,map_y FROM castles WHERE map_x IS NOT NULL AND map_y IS NOT NULL');
    const used=new Set(usedQ.rows.map(r=>r.map_x+','+r.map_y));
    let candidates=[];
    for(let radius=3;radius<100&&candidates.length===0;radius++){
      for(let x=-radius;x<=radius;x++)for(let y=-radius;y<=radius;y++){
        if(Math.max(Math.abs(x),Math.abs(y))!==radius)continue;
        if(!used.has(x+','+y))candidates.push({x,y});
      }
      // خانه‌های حلقه بیرونی را در ترتیب مارپیچی تقریبی می‌چرخانیم.
      if(candidates.length)candidates.sort((a,b)=>Math.atan2(a.y,a.x)-Math.atan2(b.y,b.x));
    }
    if(!candidates.length)throw new Error('خانه آزاد برای قلعه پیدا نشد.');
    const pos=candidates[Math.floor(Math.random()*candidates.length)];
    const army=emptyArmy(),defense=randomDefense();
    const row=await client.query(`INSERT INTO castles(id,name,army,defense_slots,username,password_hash,map_x,map_y,gold,buildings,battle_history)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,3000,$9::jsonb,'[]'::jsonb) RETURNING *`,
      [id,'قلعه '+id,JSON.stringify(army),JSON.stringify(defense),username,hashPassword(password),pos.x,pos.y,JSON.stringify(defaultBuildings())]);
    await client.query('COMMIT');
    res.status(201).json({ok:true,castle:publicCastle(row.rows[0])});
  }catch(e){await client.query('ROLLBACK');console.error('register',e);res.status(500).json({error:'ثبت‌نام انجام نشد.'});}
  finally{client.release();}
});
app.put('/api/castle/:id/development',async(req,res)=>{
  const id=Number(req.params.id);const gold=Math.max(0,Math.floor(Number(req.body.gold)||0));
  const buildings=req.body.buildings&&typeof req.body.buildings==='object'?req.body.buildings:defaultBuildings();
  if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'شماره قلعه نامعتبر است.'});
  try{const q=await pool.query('UPDATE castles SET gold=$1,buildings=$2::jsonb WHERE id=$3 RETURNING id,gold,buildings',[gold,JSON.stringify(buildings),id]);if(!q.rows[0])return res.status(404).json({error:'قلعه پیدا نشد.'});res.json({ok:true,castle:q.rows[0]});}
  catch(e){console.error('save development',e);res.status(500).json({error:'ذخیره اطلاعات توسعه قلعه ناموفق بود.'});}
});
app.get('/api/map',async(req,res)=>{
  try{const q=await pool.query('SELECT id,name,username,map_x,map_y,army,defense_slots,gold,buildings FROM castles ORDER BY id');res.json({castles:q.rows.map(r=>({id:r.id,name:r.name,username:r.username,x:r.map_x,y:r.map_y,army:r.army,defenseSlots:r.defense_slots,gold:Number(r.gold||0),buildings:r.buildings}))});}
  catch(e){console.error('map',e);res.status(500).json({error:'خواندن نقشه ناموفق بود.'});}
});

app.post("/api/reset-game", async (req,res)=>{
  if(String(req.body?.username||'').trim().toLowerCase()!=='jahan1')
    return res.status(403).json({error:'بازنشانی کامل فقط برای حساب jahan1 مجاز است.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE battle_reports, attacks, battles, castles RESTART IDENTITY CASCADE');
    const types=['archer','cavalry','swordsman'];
    const army=emptyArmy();
    for(let id=1;id<=4;id++){
      const slots=emptyDefense();
      const n=2+Math.floor(Math.random()*5);
      for(let i=0;i<n;i++)slots[i]={type:types[Math.floor(Math.random()*types.length)],count:1+Math.floor(Math.random()*100)};
      const pos=[[-2,2],[2,2],[-2,-2],[2,-2]][id-1];
      await client.query(`INSERT INTO castles(id,name,army,defense_slots,under_attack,battle_id,username,password_hash,map_x,map_y,gold,buildings,battle_history)
        VALUES($1,$2,$3::jsonb,$4::jsonb,FALSE,NULL,$5,$6,$7,$8,3000,$9::jsonb,'[]'::jsonb)`,
        [id,'قلعه '+id,JSON.stringify(army),JSON.stringify(slots),'jahan'+id,hashPassword('1234'),pos[0],pos[1],JSON.stringify({castle:{level:1},wall:{level:1},barracks1:{level:1},barracks2:{level:1},goldMine:{level:1}})]);
    }
    await client.query('COMMIT');
    res.json({ok:true,castles:await getCastles()});
  }catch(e){await client.query('ROLLBACK');console.error('reset-game',e);res.status(500).json({error:'بازنشانی اطلاعات بازی ناموفق بود.'});}
  finally{client.release();}
});

app.get("/api/state", async (req,res)=>{
  try{
    await resolveDueAttacks();
    await expireBattles();
    res.json({castles:await getCastles()});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"خطا در خواندن اطلاعات بازی"});
  }
});

app.post("/api/defense/:id", async (req,res)=>{
  const id=Number(req.params.id);
  const slots=normalizeSlots(req.body.slots);
  if(!Number.isInteger(id)||id<1)
    return res.status(400).json({error:"شماره قلعه نامعتبر است."});
  if(slots.length>6)
    return res.status(400).json({error:"حداکثر ۶ ردیف نیرو مجاز است."});

  try{
    await pool.query(
      "UPDATE castles SET defense_slots=$1::jsonb WHERE id=$2",
      [JSON.stringify(slots.concat(Array.from({length:6-slots.length},()=>({type:"",count:0}))),),id]
    );
    res.json({ok:true,castles:await getCastles()});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"ذخیره چینش دفاعی ناموفق بود."});
  }
});

app.post("/api/defenses/randomize", async (req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const types=["archer","cavalry","swordsman"];
    for(const castleRow of (await client.query("SELECT id FROM castles ORDER BY id")).rows){
      const castleId=castleRow.id;
      const slots=randomDefense();
      await client.query(
        "UPDATE castles SET defense_slots=$1::jsonb WHERE id=$2",
        [JSON.stringify(slots),castleId]
      );
    }
    await client.query("COMMIT");
    res.json({ok:true,castles:await getCastles()});
  }catch(e){
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({error:"ساخت چینش‌های تصادفی ناموفق بود."});
  }finally{client.release();}
});

app.post("/api/attack", async (req,res)=>{
  const attackerId=Number(req.body.attackerId);
  const targetId=Number(req.body.targetId);
  const side=String(req.body.armySide||"");
  const slots=normalizeSlots(req.body.attackerSlots);

  if(!Number.isInteger(attackerId)||!Number.isInteger(targetId))
    return res.status(400).json({error:"قلعه حمله‌کننده یا هدف نامعتبر است."});
  if(attackerId===targetId)
    return res.status(400).json({error:"قلعه نمی‌تواند به خودش حمله کند."});
  if(side!=="مهاجم"&&side!=="مدافع")
    return res.status(400).json({error:"ساید نیرو نامعتبر است."});
  if(!slots.length)
    return res.status(400).json({error:"حداقل یک واحد نیرو لازم است."});

  const client=await pool.connect();
  try{
    await client.query("BEGIN");

    const sourceQ=await client.query(
      "SELECT * FROM castles WHERE id=$1 FOR UPDATE",[attackerId]
    );
    const targetQ=await client.query(
      "SELECT * FROM castles WHERE id=$1",[targetId]
    );
    if(!sourceQ.rows[0]||!targetQ.rows[0]){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"قلعه پیدا نشد."});
    }
    if(!normalizeSlots(targetQ.rows[0].defense_slots).length){
      await client.query("ROLLBACK");
      return res.status(400).json({error:"قلعه هدف هنوز چینش دفاعی ندارد؛ ابتدا چینش دفاعی را ذخیره کنید."});
    }

    const source=sourceQ.rows[0];
    const army={...source.army};
    const totals={archer:0,cavalry:0,swordsman:0};
    for(const s of slots)totals[s.type]+=s.count;

    for(const type of Object.keys(names)){
      if(totals[type]>Number(army[type]||0)){
        await client.query("ROLLBACK");
        return res.status(400).json({error:`تعداد ${names[type]} بیشتر از نیروهای موجود است.`});
      }
    }

    for(const type of Object.keys(names)){
      army[type]=Number(army[type])-totals[type];
    }

    await client.query(
      "UPDATE castles SET army=$1::jsonb WHERE id=$2",
      [JSON.stringify(army),attackerId]
    );

    const arrivesAt=new Date(Date.now()+ARRIVAL_SECONDS*1000);
    const attack=await client.query(`
      INSERT INTO attacks(attacker_id,target_id,army_side,attacker_slots,arrives_at)
      VALUES($1,$2,$3,$4::jsonb,$5)
      RETURNING *
    `,[attackerId,targetId,side,JSON.stringify(slots),arrivesAt]);

    await client.query("COMMIT");

    res.json({
      ok:true,
      attack:{
        id:String(attack.rows[0].id),
        attackerId,
        targetId,
        armySide:side,
        attackerSlots:slots,
        startedAt:new Date(attack.rows[0].started_at).getTime(),
        arrivesAt:arrivesAt.getTime()
      }
    });
  }catch(e){
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({error:"ثبت حمله ناموفق بود."});
  }finally{client.release();}
});

async function resolveAttack(attackId){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");

    const aq=await client.query(
      "SELECT * FROM attacks WHERE id=$1 FOR UPDATE",[attackId]
    );
    if(!aq.rows[0])throw new Error("حمله پیدا نشد.");
    const attack=aq.rows[0];

    if(attack.status==="resolved"){
      const battle=await getBattleByTarget(attack.target_id,client);
      await client.query("COMMIT");
      return {battle};
    }

    if(Date.now()<new Date(attack.arrives_at).getTime()){
      await client.query("ROLLBACK");
      return {notDue:true,arrivesAt:new Date(attack.arrives_at).getTime()};
    }

    const targetQ=await client.query(
      "SELECT * FROM castles WHERE id=$1 FOR UPDATE",[attack.target_id]
    );
    if(!targetQ.rows[0])throw new Error("قلعه هدف پیدا نشد.");
    const target=targetQ.rows[0];

    let battle=await getBattleByTarget(attack.target_id,client);

    if(!battle){
      const defenderSlots=normalizeSlots(target.defense_slots);
      if(!defenderSlots.length)throw new Error("برای قلعه هدف چینش دفاعی ثبت نشده است.");

      const battleRow=await client.query(`
        INSERT INTO battles(target_id,defender_slots,armies,ends_at,round_number,round_started_at,round_duration_seconds,processed_round_number)
        VALUES($1,$2::jsonb,'[]'::jsonb,NOW()+INTERVAL '100 years',1,NOW(),20,0)
        RETURNING *
      `,[attack.target_id,JSON.stringify(defenderSlots)]);

      const b=battleRow.rows[0];
      const defenderArmy=makeArmy(
        "مدافع",
        attack.target_id,
        defenderSlots,
        0,
        "bat-"+b.id+"-defender"
      );

      await client.query(
        "UPDATE battles SET armies=$1::jsonb, report_armies=$2::jsonb WHERE id=$3",
        [JSON.stringify(defenderArmy?[defenderArmy]:[]), JSON.stringify(defenderArmy?[defenderArmy]:[]), b.id]
      );
      await client.query(
        "UPDATE castles SET under_attack=TRUE,battle_id=$1 WHERE id=$2",
        [b.id,attack.target_id]
      );
      battle=await getBattleByTarget(attack.target_id,client);
    }

    const sameSide=(battle.armies||[]).filter(a=>a.side===attack.army_side);
    if(sameSide.length>=4){
      await client.query(
        "UPDATE attacks SET status='rejected',resolved_at=NOW() WHERE id=$1",
        [attackId]
      );
      await returnTroops(client,attack);
      await client.query("COMMIT");
      return {battle,rejected:true};
    }

    const army=makeArmy(
      attack.army_side,
      attack.attacker_id,
      attack.attacker_slots,
      sameSide.length,
      "bat-"+battle.batId+"-attack-"+String(attack.id)
    );
    if(!army)throw new Error("ساخت ارتش ناموفق بود.");

    const armies=[...(battle.armies||[]),army];

    // شمارهٔ واحد، ستون ثابت جدول نبرد است: شماره‌های قبلی را هرگز دوباره
    // محاسبه نمی‌کنیم؛ فقط برای واحدهای تازه‌ای که هنوز شماره ندارند، ادامه می‌دهیم.
    const usedUnitNumbers=new Set();
    let nextUnitNo=1;
    for(const existingArmy of armies.slice(0,-1)){
      for(const existingUnit of (existingArmy.units||[])){
        const number=Number(existingUnit.unit);
        if(Number.isInteger(number)&&number>0){
          usedUnitNumbers.add(number);
          if(number>=nextUnitNo)nextUnitNo=number+1;
        }
      }
    }
    for(const newUnit of (army.units||[])){
      const currentNumber=Number(newUnit.unit);
      if(Number.isInteger(currentNumber)&&currentNumber>0&&!usedUnitNumbers.has(currentNumber)){
        usedUnitNumbers.add(currentNumber);
        continue;
      }
      while(usedUnitNumbers.has(nextUnitNo))nextUnitNo++;
      newUnit.unit=nextUnitNo;
      usedUnitNumbers.add(nextUnitNo);
      nextUnitNo++;
    }

    await client.query(
      "UPDATE battles SET armies=$1::jsonb, report_armies=$2::jsonb WHERE id=$3",
      [JSON.stringify(armies), JSON.stringify(mergeReportArmies(battle.report_armies, armies)), battle.batId]
    );
    await client.query(
      "UPDATE attacks SET status='resolved',resolved_at=NOW() WHERE id=$1",
      [attackId]
    );

    await client.query("COMMIT");
    return {battle:{...battle,armies}};
  }catch(e){
    await client.query("ROLLBACK");
    throw e;
  }finally{client.release();}
}

async function returnTroops(client,attack){
  const sourceQ=await client.query(
    "SELECT army FROM castles WHERE id=$1 FOR UPDATE",[attack.attacker_id]
  );
  if(!sourceQ.rows[0])return;
  const army={...sourceQ.rows[0].army};
  for(const s of normalizeSlots(attack.attacker_slots)){
    army[s.type]=Number(army[s.type]||0)+s.count;
  }
  await client.query(
    "UPDATE castles SET army=$1::jsonb WHERE id=$2",
    [JSON.stringify(army),attack.attacker_id]
  );
}

async function resolveDueAttacks(){
  const r=await pool.query(`
    SELECT id FROM attacks
    WHERE status='pending' AND arrives_at<=NOW()
    ORDER BY id
    LIMIT 20
  `);
  for(const row of r.rows){
    try{await resolveAttack(row.id);}catch(e){console.error("resolve",row.id,e);}
  }
}

app.post("/api/attack/:id/resolve",async(req,res)=>{
  try{
    const result=await resolveAttack(String(req.params.id));
    if(result.notDue)
      return res.status(409).json({error:"زمان رسیدن نیرو هنوز تمام نشده است.",arrivesAt:result.arrivesAt});
    res.json({
      ok:true,
      battle:result.battle,
      rejected:!!result.rejected,
      castles:await getCastles()
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message||"اجرای batman روی سرور ناموفق بود."});
  }
});


// وضعیت جداگانه مخصوص گزارش؛ از حذف ارتش‌ها در fotjang مستقل می‌ماند.
function mergeReportArmies(existing, current){
  const saved=Array.isArray(existing)?existing.map(a=>JSON.parse(JSON.stringify(a))):[];
  const live=Array.isArray(current)?current:[];
  const byId=new Map(saved.map(a=>[String(a.armyId),a]));
  const liveArmyIds=new Set(live.map(a=>String(a?.armyId||'')).filter(Boolean));
  // اگر ارتشی در وضعیت زنده دیگر وجود ندارد، یعنی تمام ارتشش حذف شده؛
  // snapshot گزارش نباید تعداد قدیمی آن را به‌عنوان نیروی باقی‌مانده نگه دارد.
  for(const savedArmy of saved){
    if(!liveArmyIds.has(String(savedArmy?.armyId||''))){
      savedArmy.units=(Array.isArray(savedArmy.units)?savedArmy.units:[]).map(unit=>({...unit,count:0,health:0}));
    }
  }
  for(const army of live){
    const key=String(army?.armyId||'');
    if(!key)continue;
    let target=byId.get(key);
    if(!target){
      target=JSON.parse(JSON.stringify(army));
      target.units=(target.units||[]).map(u=>({...u}));
      byId.set(key,target);
      saved.push(target);
    }
    const liveUnits=Array.isArray(army.units)?army.units:[];
    const liveById=new Map(liveUnits.map(u=>[String(u.id),u]));
    const targetUnits=Array.isArray(target.units)?target.units:[];
    for(const unit of targetUnits){
      const now=liveById.get(String(unit.id));
      unit.count=now?Math.max(0,Math.floor(Number(now.count)||0)):0;
      if(now && Number.isFinite(Number(now.health)))unit.health=Number(now.health);
      if(now?.cell)unit.cell=now.cell;
      if(Number.isFinite(Number(now?.x)))unit.x=Number(now.x);
      if(Number.isFinite(Number(now?.y)))unit.y=Number(now.y);
    }
  }
  return saved;
}

// ساخت گزارش نبرد به صورت مستقل از منطق نبرد.
// این تابع فقط snapshot ارتش‌ها را می‌گیرد و گزارش نهایی را تولید می‌کند.
function gozbat(battleRow){
  // از snapshot گزارش برای حفظ واحدهای حذف‌شده استفاده می‌کنیم، اما شمارش زنده ارتش‌ها بر آن اولویت دارد.
  const armies=mergeReportArmies(battleRow?.report_armies, battleRow?.armies);
  const reportMap=new Map();

  for(const army of armies){
    const castleId=Number(army?.castleId);
    if(!Number.isInteger(castleId))continue;
    const castleName='قلعه '+castleId;

    const initialByType={};
    for(const slot of (Array.isArray(army?.slots)?army.slots:[])){
      const rawType=String(slot?.type||'');
      if(!rawType)continue;
      initialByType[rawType]=(initialByType[rawType]||0)+Math.max(0,Math.floor(Number(slot?.count)||0));
    }

    // سازگاری با داده‌های قدیمی که slots نداشتند.
    if(!Object.keys(initialByType).length){
      for(const unit of (Array.isArray(army?.units)?army.units:[])){
        const rawType=String(unit?.rawType||'');
        if(!rawType)continue;
        initialByType[rawType]=(initialByType[rawType]||0)+Math.max(0,Math.floor(Number(unit?.initialCount ?? unit?.count)||0));
      }
    }

    const remainingByType={};
    for(const unit of (Array.isArray(army?.units)?army.units:[])){
      const rawType=String(unit?.rawType||'');
      if(!rawType)continue;
      remainingByType[rawType]=(remainingByType[rawType]||0)+Math.max(0,Math.floor(Number(unit?.count)||0));
    }

    for(const rawType of Object.keys(initialByType)){
      const initial=initialByType[rawType];
      const remaining=remainingByType[rawType]||0;
      reportMap.set(String(castleId)+'|'+rawType,{
        castleId,
        castleName,
        type:names[rawType]||rawType,
        initial,
        losses:Math.max(0,initial-remaining),
        remaining
      });
    }
  }

  return Array.from(reportMap.values());
}

app.post("/api/battle/:id/retreat", async(req,res)=>{
  const battleId=Number(req.params.id);
  const castleId=Number(req.body?.castleId);
  if(!Number.isInteger(battleId)||!Number.isInteger(castleId))
    return res.status(400).json({error:"شناسه نبرد یا قلعه نامعتبر است."});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query('SELECT * FROM battles WHERE id=$1 AND ended=FALSE FOR UPDATE',[battleId]);
    if(!q.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:"نبرد فعال پیدا نشد."});}
    const row=q.rows[0];
    const armies=Array.isArray(row.armies)?row.armies:[];
    const retreating=armies.filter(a=>Number(a.castleId)===castleId);
    if(!retreating.length){await client.query('ROLLBACK');return res.status(404).json({error:"نیرویی از این قلعه در نبرد نیست."});}
    const reportArmies=mergeReportArmies(row.report_armies,armies);
    const retreatIds=new Set(retreating.map(a=>String(a.armyId)));
    for(const a of reportArmies){if(retreatIds.has(String(a.armyId))){a.units=(a.units||[]).map(u=>({...u,count:0,health:0}));a.retreated=true;}}
    const remaining=armies.filter(a=>Number(a.castleId)!==castleId);
    const liveUnits=remaining.flatMap(a=>(a.units||[]).filter(u=>Number(u.count)>0).map(u=>({side:u.side||a.side,count:Number(u.count)})));
    const sides=new Set(liveUnits.map(u=>u.side));
    let ended=false, winnerSide=null;
    if(liveUnits.length===0||sides.size<=1){
      ended=true;
      winnerSide=liveUnits.length?liveUnits[0].side:(retreating[0].side==='مهاجم'?'مدافع':'مهاجم');
      const finalRow={...row,armies:remaining,report_armies:reportArmies};
      const report=gozbat(finalRow);
      await client.query(`INSERT INTO battle_reports(battle_id,report,winner_side) VALUES($1,$2::jsonb,$3) ON CONFLICT(battle_id) DO UPDATE SET report=EXCLUDED.report,winner_side=EXCLUDED.winner_side,created_at=NOW()`,[battleId,JSON.stringify(report),winnerSide]);
      await client.query('DELETE FROM battles WHERE id=$1',[battleId]);
      await client.query('DELETE FROM attacks WHERE target_id=$1 AND status=\'resolved\'',[row.target_id]);
      await client.query('UPDATE castles SET under_attack=FALSE,battle_id=NULL WHERE id=$1 AND battle_id=$2',[row.target_id,battleId]);
    }else{
      await client.query('UPDATE battles SET armies=$1::jsonb,report_armies=$2::jsonb WHERE id=$3',[JSON.stringify(remaining),JSON.stringify(reportArmies),battleId]);
    }
    await client.query('COMMIT');
    res.json({ok:true,ended,winnerSide,battle:ended?null:battleJson({...row,armies:remaining,report_armies:reportArmies})});
  }catch(e){
    try{await client.query('ROLLBACK');}catch{}
    console.error('battle retreat failed',e);
    res.status(500).json({error:'ذخیره عقب‌نشینی در SQL ناموفق بود.'});
  }finally{client.release();}
});

app.post("/api/battle/:id/end", async(req,res)=>{
  const battleId=Number(req.params.id);
  if(!Number.isInteger(battleId))
    return res.status(400).json({error:"شماره نبرد نامعتبر است."});

  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const r=await client.query(
      'SELECT target_id FROM battles WHERE id=$1 AND ended=FALSE FOR UPDATE',
      [battleId]
    );
    if(!r.rows[0]){
      await client.query('COMMIT');
      return res.json({ok:true,deleted:false});
    }
    const battleRow=r.rows[0];
    const fullBattleQ=await client.query(
      'SELECT * FROM battles WHERE id=$1 FOR UPDATE',
      [battleId]
    );
    const fullBattle=fullBattleQ.rows[0];

    // گزارش کاملاً مستقل از حذف نبرد ساخته و در جدول مخصوص گزارش‌ها ذخیره می‌شود.
    const report=gozbat(fullBattle);
    await client.query(
      `INSERT INTO battle_reports(battle_id,report,winner_side)
       VALUES($1,$2::jsonb,$3)
       ON CONFLICT (battle_id) DO UPDATE SET
         report=EXCLUDED.report,
         winner_side=EXCLUDED.winner_side,
         created_at=NOW()`,
      [battleId,JSON.stringify(report),req.body?.winnerSide||null]
    );

    await client.query('DELETE FROM battles WHERE id=$1',[battleId]);
    await client.query(
      'DELETE FROM attacks WHERE target_id=$1 AND status=\'resolved\'',
      [battleRow.target_id]
    );
    await client.query(
      'UPDATE castles SET under_attack=FALSE,battle_id=NULL WHERE id=$1 AND battle_id=$2',
      [battleRow.target_id,battleId]
    );
    await client.query('COMMIT');
    res.json({ok:true,deleted:true,battleId,reportSaved:true});
  }catch(e){
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({error:"پاک کردن اطلاعات نبرد ناموفق بود."});
  }finally{client.release();}
});

app.get("/api/pending", async (req,res)=>{
  const castleId=Number(req.query.castleId);
  if(!Number.isInteger(castleId))
    return res.status(400).json({error:"شماره قلعه نامعتبر است."});
  try{
    await resolveDueAttacks();
    await expireBattles();
    const r=await pool.query(`
      SELECT id,attacker_id,target_id,army_side,arrives_at
      FROM attacks
      WHERE attacker_id=$1 AND status='pending'
      ORDER BY id DESC
      LIMIT 1
    `,[castleId]);
    if(!r.rows[0]) return res.json({attack:null});
    const a=r.rows[0];
    res.json({attack:{
      id:String(a.id),
      attackerId:a.attacker_id,
      targetId:a.target_id,
      armySide:a.army_side,
      arrivesAt:new Date(a.arrives_at).getTime()
    }});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"خطا در خواندن حمله در حال حرکت"});
  }
});

app.get("/api/battle/current",async(req,res)=>{
  const castleId=Number(req.query.castleId);
  if(!Number.isInteger(castleId))
    return res.status(400).json({error:"شماره قلعه نامعتبر است."});
  try{
    await resolveDueAttacks();
    await expireBattles();
    res.json({battle:await currentBattleForCastle(castleId)});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"خطا در خواندن نبرد"});
  }
});

app.get("/health",async(req,res)=>{
  try{
    await pool.query("SELECT 1");
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false});}
});

app.use("/images", express.static(path.join(__dirname, "public", "images")));

app.use(express.static(__dirname, {
  index: "index.html",
  extensions: ["html"]
}));

initDb()
  .then(()=>{
    // شماره و مبدأ راند فقط در round/commit جلو می‌روند؛ هیچ تایمر موازی SQL آن‌ها را تغییر نمی‌دهد.
    app.listen(PORT,()=>console.log(`Game server listening on ${PORT}`));
  })
  .catch(err=>{
    console.error(err);
    process.exit(1);
  });
