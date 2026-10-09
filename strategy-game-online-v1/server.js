const express = require("express");
const path = require("path");
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
      ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
      ended BOOLEAN NOT NULL DEFAULT FALSE,
      winner_side TEXT,
      report_armies JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);

  await pool.query(`
    ALTER TABLE battles ADD COLUMN IF NOT EXISTS report_armies JSONB NOT NULL DEFAULT '[]'::jsonb
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS battle_reports (
      id BIGSERIAL PRIMARY KEY,
      battle_id BIGINT NOT NULL UNIQUE,
      report JSONB NOT NULL,
      winner_side TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO castles(id,name,army,defense_slots)
    SELECT x, 'قلعه '||x, $1::jsonb, $2::jsonb
    FROM generate_series(1,11) x
    ON CONFLICT (id) DO NOTHING
  `,[JSON.stringify(emptyArmy()), JSON.stringify(emptyDefense())]);

  await pool.query(`
    ALTER TABLE battles
    ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ
  `);
  await pool.query(`
    UPDATE battles
    SET ends_at = created_at + INTERVAL '30 minutes'
    WHERE ends_at IS NULL
  `);
  await pool.query(`
    ALTER TABLE battles
    ALTER COLUMN ends_at SET DEFAULT (NOW() + INTERVAL '30 minutes')
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
    battleId:row.battle_id
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
        const destination=String(unit.moveTarget||"").toUpperCase();
        const m=/^([A-T])(1[0-2]|[1-9])$/.exec(destination);
        if(!m)continue;
        const x=Number(m[2])-1;
        const y="ABCDEFGHIJKLMNOPQRST".indexOf(m[1]);
        if(x<0||x>11||y<0||y>19)continue;
        unit.cell=destination;
        unit.x=x;
        unit.y=y;
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

app.put("/api/battle/:id/state", async (req,res)=>{
  const id=Number(req.params.id);
  const armies=Array.isArray(req.body.armies)?req.body.armies:null;
  if(!Number.isInteger(id)||!armies)return res.status(400).json({error:"اطلاعات حرکت نامعتبر است."});

  try{
    const current=await pool.query(
      "SELECT report_armies FROM battles WHERE id=$1 AND ended=FALSE AND ends_at>NOW() FOR UPDATE",
      [id]
    );
    if(!current.rows[0])return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    const reportArmies=mergeReportArmies(current.rows[0].report_armies,armies);
    const r=await pool.query(
      `UPDATE battles
       SET armies=$1::jsonb, report_armies=$2::jsonb
       WHERE id=$3 AND ended=FALSE AND ends_at>NOW()
       RETURNING *`,
      [JSON.stringify(armies),JSON.stringify(reportArmies),id]
    );
    if(!r.rows[0])return res.status(404).json({error:"نبرد فعال پیدا نشد."});
    res.json({ok:true,battle:battleJson(r.rows[0])});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"ذخیره موقعیت نیروها ناموفق بود."});
  }
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
app.post("/api/reset-game", async (req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");

    // همه نبردها، حمله‌ها و اطلاعات قلعه‌های قبلی حذف می‌شوند.
    await client.query("TRUNCATE TABLE attacks, battles, castles RESTART IDENTITY CASCADE");

    await client.query(`
      INSERT INTO castles(id,name,army,defense_slots,under_attack,battle_id)
      SELECT x, 'قلعه '||x, $1::jsonb, $2::jsonb, FALSE, NULL
      FROM generate_series(1,11) x
    `,[JSON.stringify(emptyArmy()), JSON.stringify(emptyDefense())]);

    await client.query("COMMIT");
    res.json({ok:true,castles:await getCastles()});
  }catch(e){
    await client.query("ROLLBACK");
    console.error("reset-game",e);
    res.status(500).json({error:"پاک‌سازی و بازنویسی اطلاعات بازی ناموفق بود."});
  }finally{
    client.release();
  }
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
  if(!Number.isInteger(id)||id<1||id>11)
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
    for(let castleId=1;castleId<=11;castleId++){
      const slots=emptyDefense();
      const n=1+Math.floor(Math.random()*6);
      for(let i=0;i<n;i++){
        slots[i]={
          type:types[Math.floor(Math.random()*types.length)],
          count:1+Math.floor(Math.random()*100)
        };
      }
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
        INSERT INTO battles(target_id,defender_slots,armies,ends_at)
        VALUES($1,$2::jsonb,'[]'::jsonb,NOW()+INTERVAL '30 minutes')
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
      "bat-"+battle.batId+"-army-"+((battle.armies||[]).length+1)
    );
    if(!army)throw new Error("ساخت ارتش ناموفق بود.");

    const armies=[...(battle.armies||[]),army];
    let unitNo=1;
    for(const a of armies){
      for(const u of (a.units||[]))u.unit=unitNo++;
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
  const armies=Array.isArray(battleRow?.report_armies)?battleRow.report_armies:(Array.isArray(battleRow?.armies)?battleRow.armies:[]);
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
    app.listen(PORT,()=>console.log(`Game server listening on ${PORT}`));
  })
  .catch(err=>{
    console.error(err);
    process.exit(1);
  });
