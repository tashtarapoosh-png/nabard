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

  // PostgreSQL/pg cannot execute multiple commands in one prepared statement
  // when query parameters are supplied, so each command is sent separately.
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
      winner_side TEXT
    )
  `);

  await pool.query(`
    INSERT INTO castles(id,name,army,defense_slots)
    SELECT x, 'قلعه '||x, $1::jsonb, $2::jsonb
    FROM generate_series(1,11) x
    ON CONFLICT (id) DO NOTHING
  `, [JSON.stringify(emptyArmy()), JSON.stringify(emptyDefense())]);

  // برای دیتابیس‌هایی که قبل از اضافه شدن زمان پایان ساخته شده‌اند.
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
    winnerSide:b.winner_side
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
    winnerSide:row.winner_side
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
        "UPDATE battles SET armies=$1::jsonb WHERE id=$2",
        [JSON.stringify(defenderArmy?[defenderArmy]:[]),b.id]
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
      "UPDATE battles SET armies=$1::jsonb WHERE id=$2",
      [JSON.stringify(armies),battle.batId]
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
    const targetId=r.rows[0].target_id;
    await client.query('DELETE FROM battles WHERE id=$1',[battleId]);
    await client.query(
      'DELETE FROM attacks WHERE target_id=$1 AND status=\'resolved\'',
      [targetId]
    );
    await client.query(
      'UPDATE castles SET under_attack=FALSE,battle_id=NULL WHERE id=$1 AND battle_id=$2',
      [targetId,battleId]
    );
    await client.query('COMMIT');
    res.json({ok:true,deleted:true,battleId});
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

app.post("/api/reset-game", async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");

    // بازگشت کامل بازی به وضعیت ابتدای نصب: همه حمله‌ها و نبردها حذف می‌شوند،
    // نیروهای قلعه‌ها به ۱۰۰ عدد از هر نوع برمی‌گردند و چینش دفاعی پاک می‌شود.
    await client.query("TRUNCATE TABLE attacks, battles RESTART IDENTITY");
    await client.query(`
      UPDATE castles
      SET army=$1::jsonb,
          defense_slots=$2::jsonb,
          under_attack=FALSE,
          battle_id=NULL
    `,[JSON.stringify(emptyArmy()),JSON.stringify(emptyDefense())]);

    await client.query("COMMIT");
    res.json({ok:true,reset:true});
  }catch(e){
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({error:"بازگردانی بازی به حالت ابتدای نصب ناموفق بود."});
  }finally{
    client.release();
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

app.use(express.static(__dirname, {
  index: "index.html",
  extensions: ["html"]
}));

// تصاویر بازی در public/images قرار دارند.
app.use("/images", express.static(path.join(__dirname, "public", "images")));

initDb()
  .then(()=>{
    app.listen(PORT,()=>console.log(`Game server listening on ${PORT}`));
  })
  .catch(err=>{
    console.error(err);
    process.exit(1);
  });
