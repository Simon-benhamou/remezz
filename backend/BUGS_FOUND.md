#1 . creation of agent from the front 
when I select a symbol from the modal the api create me 4 agents. it should create the one of the symbol selected. 

#.2 when I set a paper balance I don't see the update. 
the capital pool is shared between the agent. when an agent found an opportunity he reserve a part of the capital (if available) for his trade. if no capital so trade rejected. same principle in live but we only take the balance from the exchange. 
Any change on capital shouldn't affect the agent as it's global to the user. 

#.3 live mode I see free capital 69 but total 0. 

#4. when I click on an agents in /agents I should be redirected to agents/sessionid (i see the url going to agents/sessionid) but then I get redirected to the operations page. 

#5. pausing an agents doesn't work. 

6# when I click on profolio I got redirected to operations page. 


7# make sure full flow is working
- websocket first (I want to see the agents working in the log of prod , lick processing tick) (user the user api key of binance)
- make sure agents works simultanously (without any ban of the api rest)
- agents has to apply the strategy we got in the backtest-ultra-realistic.mjs. 
- display in the DashboardCompact clearly if conditions are good for the strategy (so I know if I should have trade or not)
- make sure it's working for live and paper with the difference on live that we take the balance of the exchange and actualy place the order in the exchange we need to be synchornized if a stop loss got executed in the exchange (100% match between our application and the exchange). in paper mode we genre register the order in the db and change the status of agents to managed. so then the exit logic apply with the thrailing stop. 
#8 did I forgot something to be sure we're all set? make other verification so everything is align backend and frontend both should work perfectly. WE should have similar result as the test in production. 
