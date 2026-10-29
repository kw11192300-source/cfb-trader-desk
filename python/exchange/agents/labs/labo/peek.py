import pandas as pd
from exchange.agents.pack import Pack
p = Pack()
nb = pd.read_csv(p.path("nba","odds.csv")); cb = pd.read_csv(p.path("cbb","closing_odds.csv")); nh = pd.read_csv(p.path("nhl","odds.csv.gz"))
for sp,df,col,sc,tc in [("nba",nb,"event_id","spread_home_close","total_close"),("cbb",cb,"event_id","spread_home_close","total_close"),("nhl",nh,"espn_id","pl_home_close","total_close")]:
    g=p.games(sp); ids=set(g.id)
    k = sp+":"+df[col].astype("Int64").astype(str)
    m = df[k.isin(ids)]
    print(sp,"overlap rows",len(m),"unique",m[col].nunique(),"with spread",m[sc].notna().sum(),"total",m[tc].notna().sum(), m.groupby(m.columns[1] if sp!="nhl" else "provider").size().to_dict())
c=p.closing(); print(len(c), c.columns.tolist())
