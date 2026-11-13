-- =====================================================
-- VRT HUB — PET SIMULATOR 99 v2.0.1
-- v2.0.1: tương thích Arceus X Neon + bỏ tab Event (Diamond Mountain)
-- Bỏ hết button "once/now", chỉ giữ toggle
-- Flag: chỉ dùng khi trong zone, không teleport
-- Egg hook: kiểu 25MS (gán PlayEggAnimation + Message.Bottom của game)
-- =====================================================

if getgenv().VRT_LOADED then
	if typeof(getgenv().VRT_Unload) == "function" then
		pcall(getgenv().VRT_Unload)
		task.wait(0.3)
	end
	getgenv().VRT_LOADED = nil
	getgenv().VRT_AntiAFK = nil
end
getgenv().VRT_LOADED = true

pcall(setthreadidentity, 4)

if not game:IsLoaded() then
	game.Loaded:Wait()
end

-- Services.
local playersService = game:GetService("Players")
local replicatedStorage = game:GetService("ReplicatedStorage")
local runService = game:GetService("RunService")
local userInputService = game:GetService("UserInputService")
local debrisService = game:GetService("Debris")
local httpService = game:GetService("HttpService")
local marketplaceService = game:GetService("MarketplaceService")
local tweenService = game:GetService("TweenService")

local localPlayer = playersService.LocalPlayer
local libraryFolder = replicatedStorage:WaitForChild("Library")
local clientFolder = libraryFolder:WaitForChild("Client")
local directoryFolder = libraryFolder:WaitForChild("Directory")
local utilFolder = libraryFolder:FindFirstChild("Util")
local networkFolder = replicatedStorage:WaitForChild("Network")
local directFolder = replicatedStorage:FindFirstChild("__DIRECTORY")

-- -----------------------------------------------------
-- EXECUTOR COMPAT (Arceus X Neon + các executor mobile khác)
-- Hàm executor nào cũng được kiểm tra trước khi gọi, thiếu thì fallback.
-- -----------------------------------------------------
local function hasFn(value)
	return typeof(value) == "function"
end

local executorName = "Unknown"
pcall(function()
	if hasFn(identifyexecutor) then
		executorName = tostring((identifyexecutor()) or "Unknown")
	end
end)

local isArceus = executorName:lower():find("arceus", 1, true) ~= nil

-- Mỗi executor đặt tên hàm HTTP khác nhau.
local httpRequest = nil
if hasFn(request) then
	httpRequest = request
elseif hasFn(http_request) then
	httpRequest = http_request
elseif typeof(syn) == "table" and hasFn(syn.request) then
	httpRequest = syn.request
elseif typeof(http) == "table" and hasFn(http.request) then
	httpRequest = http.request
end

-- File system: thiếu hàm nào thì tắt lưu config thay vì crash.
local fsReady = hasFn(isfile) and hasFn(isfolder) and hasFn(makefolder)
	and hasFn(readfile) and hasFn(writefile)

local function safeIsFile(path)
	if not hasFn(isfile) then return false end
	local ok, result = pcall(isfile, path)
	return ok and result == true
end

local function safeDelFile(path)
	if not hasFn(delfile) then return false end
	return (pcall(delfile, path))
end

local getUpvalue = nil
if typeof(debug) == "table" and hasFn(debug.getupvalue) then
	getUpvalue = debug.getupvalue
elseif hasFn(getupvalue) then
	getUpvalue = getupvalue
end

-- Tải text từ URL: thử game:HttpGet trước, không được thì dùng request.
local function fetchUrl(url)
	local ok, body = pcall(function()
		return game:HttpGet(url)
	end)
	if ok and typeof(body) == "string" and #body > 0 then
		return body
	end
	if httpRequest then
		local okReq, response = pcall(httpRequest, { Url = url, Method = "GET" })
		if okReq and typeof(response) == "table" and typeof(response.Body) == "string" and #response.Body > 0 then
			return response.Body
		end
	end
	return nil
end

-- -----------------------------------------------------
-- ANTI-CHEAT BYPASS
-- -----------------------------------------------------
local AntiCheat = {}
AntiCheat.active = false
AntiCheat.originalKey = nil
AntiCheat.logBlocked = false
AntiCheat.blockedCount = 0
AntiCheat.lastBlocked = nil

local function reqCheck()
	local issues = {}
	if not httpRequest then
		table.insert(issues, "NO_REQUEST")
		return false, issues
	end
	-- Arceus X cài request bằng Lua nên bỏ qua check "what", tránh chặn nhầm webhook.
	if not isArceus then
		local okInfo, info = pcall(debug.getinfo, httpRequest)
		if okInfo and info and info.what == "Lua" then
			table.insert(issues, "WHAT")
		end
	end
	if hasFn(isfunctionhooked) then
		local okHook, hooked = pcall(isfunctionhooked, httpRequest)
		if okHook and hooked then
			table.insert(issues, "HOOKED")
		end
	end
	return #issues == 0, issues
end

local function installBlunderBypass()
	local ok, blunderMessage = pcall(function()
		return require(replicatedStorage:WaitForChild("Blunder", 10):WaitForChild("BlunderMessage", 10))
	end)
	if not ok or typeof(blunderMessage) ~= "table" then
		return false
	end
	if AntiCheat.originalKey then
		return true
	end
	AntiCheat.originalKey = blunderMessage.key
	local hook = function(...)
		local args = { ... }
		local payload = args[1]
		if typeof(payload) ~= "table" then
			return AntiCheat.originalKey(...)
		end
		local message = payload.message
		local messageType = payload.messageType
		if message == "PING" or message == "Anti Cheat fetched error in console" then
			return AntiCheat.originalKey(...)
		end
		AntiCheat.blockedCount += 1
		AntiCheat.lastBlocked = { message = message, messageType = messageType, time = os.clock() }
		if AntiCheat.logBlocked then
			warn("[VRT AC] Blocked:", tostring(messageType), tostring(message))
		end
		return
	end
	pcall(setstackhidden, hook, true)
	pcall(debug.setinfo, hook, "s", "[C]")
	pcall(debug.setinfo, hook, "n", "")
	if hasFn(setreadonly) then pcall(setreadonly, blunderMessage, false) end
	local okSet = pcall(function() blunderMessage.key = hook end)
	if not okSet then okSet = pcall(rawset, blunderMessage, "key", hook) end
	if hasFn(setreadonly) then pcall(setreadonly, blunderMessage, true) end
	if not okSet then
		AntiCheat.originalKey = nil
		warn("[VRT AC] Không ghi đè được BlunderMessage.key (executor thiếu setreadonly?)")
		return false
	end
	AntiCheat.active = true
	return true
end
installBlunderBypass()

-- -----------------------------------------------------
-- Modules.
-- -----------------------------------------------------
local function safeRequire(instance)
	if not instance or typeof(instance) ~= "Instance" then
		return nil
	end
	local ok, result = pcall(require, instance)
	return ok and result or nil
end

local Modules = {
	Network = safeRequire(clientFolder:FindFirstChild("Network")),
	Save = safeRequire(clientFolder:FindFirstChild("Save")),
	EggCmds = safeRequire(clientFolder:FindFirstChild("EggCmds")),
	CustomEggsCmds = safeRequire(clientFolder:FindFirstChild("CustomEggsCmds")),
	HatchingCmds = safeRequire(clientFolder:FindFirstChild("HatchingCmds")),
	DaycareCmds = safeRequire(clientFolder:FindFirstChild("DaycareCmds")),
	PetEquipCmds = safeRequire(clientFolder:FindFirstChild("PetEquipCmds")),
	UltimateCmds = safeRequire(clientFolder:FindFirstChild("UltimateCmds")),
	ZoneCmds = safeRequire(clientFolder:FindFirstChild("ZoneCmds")),
	MapCmds = safeRequire(clientFolder:FindFirstChild("MapCmds")),
	LootboxCmds = safeRequire(clientFolder:FindFirstChild("LootboxCmds")),
	FruitCmds = safeRequire(clientFolder:FindFirstChild("FruitCmds")),
	RankCmds = safeRequire(clientFolder:FindFirstChild("RankCmds")),
	RebirthCmds = safeRequire(clientFolder:FindFirstChild("RebirthCmds")),
	FlexibleFlagCmds = safeRequire(clientFolder:FindFirstChild("FlexibleFlagCmds")),
	ZoneFlagCmds = safeRequire(clientFolder:FindFirstChild("ZoneFlagCmds")),
	PlayerPet = safeRequire(clientFolder:FindFirstChild("PlayerPet")),
	Balancing = safeRequire(clientFolder:FindFirstChild("Balancing")),
	NotificationCmds = safeRequire(clientFolder:FindFirstChild("NotificationCmds")),
	InstancingCmds = safeRequire(clientFolder:FindFirstChild("InstancingCmds")),
	InstanceZoneCmds = safeRequire(clientFolder:FindFirstChild("InstanceZoneCmds")),
	MasteryCmds = safeRequire(clientFolder:FindFirstChild("MasteryCmds")),
	CurrencyCmds = safeRequire(clientFolder:FindFirstChild("CurrencyCmds")),
	MachineScreens = safeRequire(clientFolder:FindFirstChild("MachineScreens")),
	WorldsUtil = safeRequire(utilFolder and utilFolder:FindFirstChild("WorldsUtil")),
	ZonesUtil = safeRequire(utilFolder and utilFolder:FindFirstChild("ZonesUtil")),
	EggsUtil = safeRequire(utilFolder and utilFolder:FindFirstChild("EggsUtil")),
	MerchantUtil = safeRequire(utilFolder and utilFolder:FindFirstChild("MerchantUtil")),
	DaycareUtil = safeRequire(utilFolder and utilFolder:FindFirstChild("DaycareUtil")),
	Ranks = safeRequire(directoryFolder:FindFirstChild("Ranks")),
	FreeGifts = safeRequire(directoryFolder:FindFirstChild("FreeGifts")),
	EggsDir = safeRequire(directoryFolder:FindFirstChild("Eggs")),
	ZonesDir = safeRequire(directoryFolder:FindFirstChild("Zones")),
	PetsDir = safeRequire(directoryFolder:FindFirstChild("Pets")),
	ZoneFlagsDir = safeRequire(directoryFolder:FindFirstChild("ZoneFlags")),
	MerchantsDir = safeRequire(directoryFolder:FindFirstChild("Merchants")),
	Items = safeRequire(libraryFolder:FindFirstChild("Items")),
}

local network = Modules.Network

local function invoke(name, ...)
	if not network or not network.Invoke then return false end
	local ok, result = pcall(network.Invoke, name, ...)
	if ok then return true, result end
	if typeof(result) == "string" and result:find("assertion failed") then
		return pcall(network.Invoke, network, name, ...)
	end
	return false, result
end

local function fire(name, ...)
	if not network or not network.Fire then return false end
	local ok, result = pcall(network.Fire, name, ...)
	if ok then return true, result end
	if typeof(result) == "string" and result:find("assertion failed") then
		return pcall(network.Fire, network, name, ...)
	end
	return false, result
end

local function unreliable(name, ...)
	if not network or not network.UnreliableFire then return false end
	local ok, result = pcall(network.UnreliableFire, name, ...)
	if ok then return true, result end
	if typeof(result) == "string" and result:find("assertion failed") then
		return pcall(network.UnreliableFire, network, name, ...)
	end
	return false, result
end

-- -----------------------------------------------------
-- Settings.
-- -----------------------------------------------------
local vrt = getgenv().VRT or {}
getgenv().VRT = vrt
vrt.Version = "2.0.1"
vrt.connections = {}
vrt.loops = {}
vrt.fruitLog = {}
vrt.customEggMap = {}

local settings = vrt.Settings or {}
vrt.Settings = settings

local defaults = {
	ClickAuraRadius = 75,
	ClickAuraCooldown = 0.016,
	FastFarmCooldown = 0.2,
	FastFarmHeartbeat = false,
	FastFarmLoop = false,
	CollectOrbs = false,
	ClickAura = false,
	ClickAuraViz = false,
	OpenEgg = false,
	OpenSelectedEgg = false,
	SelectedEggId = "",
	BuySelectedCustomEgg = false,
	SelectedCustomEggUuid = "",
	HideEggAnim = false,
	HookEggAnimation = false,
	InfinitePetSpeed = false,
	OptimizePets = false,
	AntiLag = false,
	Daycare = false,
	PetSlots = false,
	AutoEggSlots = false,
	Zones = false,
	Rebirth = false,
	Ultimate = false,
	FreeGifts = false,
	RankRewards = false,
	MailboxClaim = false,
	MailboxSendHuges = false,
	MailboxUsername = "",
	MailboxHugeMode = "New",
	Relics = false,
	SpinWheels = false,
	OpenChests = false,
	CombineKeysAll = false,
	CombineKeysOnce = false,
	OpenGifts = false,
	OpenLootboxes = false,
	ConsumeFruits = false,
	AutoTimeTrial = false,
	FarmTreehouse = false,
	UpgradeFruits = false,
	UpgradeFruitsShiny = false,
	UpgradePotions = false,
	UpgradeEnchants = false,
	EmpowerEnchants = false,
	CardCombine = false,
	FusePets = false,
	FuseAmount = 5,
	GoldMachine = false,
	RainbowMachine = false,
	CoinJar = false,
	Comet = false,
	AutoRank = false,
	SelectedFlag = "Coins Flag",
	AutoUseFlagInZone = false,
	FlagAmount = 45,
	FarmPoint = nil,
	UseFarmPoint = false,
	AdminAbuse = false,
	WebhookUrl = "",
	WebhookEnabled = false,
	SelectedWheels = { "All" },
	SelectedChests = { "All" },
	SelectedGifts = { "All" },
	SelectedLootboxes = { "All" },
	SelectedFruits = { "All" },
	SelectedFruitUpgrade = { "All" },
	SelectedEnchantRarity = { "All" },
	eggUnmappedWarned = {},
}

for key, value in pairs(defaults) do
	if settings[key] == nil then
		settings[key] = value
	end
end

if typeof(settings.eggUnmappedWarned) ~= "table" then
	settings.eggUnmappedWarned = {}
end

-- -----------------------------------------------------
-- CONFIG
-- -----------------------------------------------------
local CONFIG_FOLDER = "VRT"
local CONFIG_PATH = "VRT/PS99_Config.json"

local PERSIST_KEYS = {
	"ClickAuraRadius", "ClickAuraCooldown", "FastFarmCooldown",
	"FastFarmHeartbeat", "FastFarmLoop", "CollectOrbs",
	"ClickAura", "ClickAuraViz",
	"OpenEgg", "OpenSelectedEgg", "SelectedEggId",
	"BuySelectedCustomEgg", "SelectedCustomEggUuid",
	"HideEggAnim", "HookEggAnimation",
	"InfinitePetSpeed", "OptimizePets", "AntiLag",
	"Daycare", "PetSlots", "AutoEggSlots", "Zones", "Rebirth", "Ultimate",
	"FreeGifts", "RankRewards",
	"MailboxClaim", "MailboxSendHuges", "MailboxUsername", "MailboxHugeMode",
	"Relics", "SpinWheels", "OpenChests",
	"CombineKeysAll", "CombineKeysOnce",
	"OpenGifts", "OpenLootboxes", "ConsumeFruits",
	"AutoTimeTrial",
	"FarmTreehouse",
	"UpgradeFruits", "UpgradeFruitsShiny",
	"UpgradePotions", "UpgradeEnchants", "EmpowerEnchants",
	"CardCombine", "FusePets", "FuseAmount", "GoldMachine", "RainbowMachine",
	"CoinJar", "Comet",
	"AutoRank",
	"SelectedFlag", "AutoUseFlagInZone", "FlagAmount",
	"UseFarmPoint", "AdminAbuse",
	"WebhookUrl", "WebhookEnabled",
}

local TABLE_KEYS = {
	"SelectedWheels", "SelectedChests", "SelectedGifts",
	"SelectedLootboxes", "SelectedFruits",
	"SelectedFruitUpgrade", "SelectedEnchantRarity",
	"FarmPoint",
}

local persistSet = {}
for _, key in ipairs(PERSIST_KEYS) do persistSet[key] = true end
for _, key in ipairs(TABLE_KEYS) do persistSet[key] = true end

local function saveConfig()
	if not fsReady then return end
	pcall(function()
		if not isfolder(CONFIG_FOLDER) then
			makefolder(CONFIG_FOLDER)
		end
		local out = {}
		for _, key in ipairs(PERSIST_KEYS) do
			local value = settings[key]
			if value ~= nil then
				out[key] = value
			end
		end
		for _, key in ipairs(TABLE_KEYS) do
			local value = settings[key]
			if typeof(value) == "table" then
				out[key] = value
			end
		end
		writefile(CONFIG_PATH, httpService:JSONEncode(out))
	end)
end

local function loadConfig()
	if not safeIsFile(CONFIG_PATH) or not hasFn(readfile) then return end
	pcall(function()
		local decoded = httpService:JSONDecode(readfile(CONFIG_PATH))
		if typeof(decoded) ~= "table" then return end
		for key, value in pairs(decoded) do
			if defaults[key] ~= nil or persistSet[key] then
				settings[key] = value
			end
		end
	end)
end

loadConfig()

local saveQueued = false

local function queueSave()
	if saveQueued then return end
	saveQueued = true
	task.delay(1, function()
		saveQueued = false
		saveConfig()
	end)
end

getgenv().VRT_SaveConfig = saveConfig
getgenv().VRT_LoadConfig = loadConfig

-- -----------------------------------------------------
-- STATIC DATA
-- -----------------------------------------------------
local FLAGS = {
	"Coins Flag", "Diamonds Flag", "Exotic Treasure Flag",
	"Fortune Flag", "Golden Flag", "Hasty Flag",
	"Magnet Flag", "Rainbow Flag", "Shiny Flag", "Strength Flag",
}

local OPTIMIZE_SIZE = Vector3.new(2.5, 2.5, 2.5)
local OPTIMIZE_MATERIAL = Enum.Material.SmoothPlastic
local VIZ_ROTATION = CFrame.Angles(0, 0, math.rad(90))
local TREEHOUSE_ID = "TreehouseMerchant"
local TREEHOUSE_ROOM = "Treehouse Merchant"
local LOOTBOX_BATCH = 8

local function cleanupTreehouseModels()
	local playerGui = localPlayer:FindFirstChild("PlayerGui")
	if not playerGui then return end
	for _, child in ipairs(playerGui:GetChildren()) do
		if child:IsA("Model") and child.Name == TREEHOUSE_ID then
			child:Destroy()
		end
	end
end

-- -----------------------------------------------------
-- SAVE CACHE + INVENTORY INDEX
-- -----------------------------------------------------
local SKIP_BUCKETS = { Pet = true }
local SaveCache = { data = nil, timestamp = 0, ttl = 2 }
local InventoryIndex = { byId = {}, uidById = {}, bucketIds = {}, timestamp = 0, ttl = 5, dirty = true }

local function getSaveCached()
	local now = os.clock()
	if SaveCache.data and (now - SaveCache.timestamp) < SaveCache.ttl then
		return SaveCache.data
	end
	if not Modules.Save or not Modules.Save.Get then return nil end
	local ok, save = pcall(Modules.Save.Get)
	if ok and typeof(save) == "table" and next(save) then
		SaveCache.data = save
		SaveCache.timestamp = now
		return save
	end
	return SaveCache.data
end

local function invalidateSaveCache()
	SaveCache.data = nil
	SaveCache.timestamp = 0
	InventoryIndex.dirty = true
end

getgenv().VRT_InvalidateCache = invalidateSaveCache

local function buildInventoryIndex()
	local now = os.clock()
	if not InventoryIndex.dirty and (now - InventoryIndex.timestamp) < InventoryIndex.ttl then
		return InventoryIndex
	end
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" then
		return InventoryIndex
	end
	local byId, uidById, bucketIds = {}, {}, {}
	for bucketName, bucket in pairs(save.Inventory) do
		if not SKIP_BUCKETS[bucketName] and typeof(bucket) == "table" then
			local ids, seen = {}, {}
			for uid, entry in pairs(bucket) do
				if typeof(entry) == "table" and typeof(entry.id) == "string" then
					byId[entry.id] = entry
					uidById[entry.id] = uid
					if not seen[entry.id] then
						seen[entry.id] = true
						table.insert(ids, entry.id)
					end
				end
			end
			table.sort(ids)
			bucketIds[bucketName] = ids
		end
	end
	InventoryIndex.byId = byId
	InventoryIndex.uidById = uidById
	InventoryIndex.bucketIds = bucketIds
	InventoryIndex.timestamp = now
	InventoryIndex.dirty = false
	return InventoryIndex
end

local function findInventoryEntry(itemId)
	if not itemId or itemId == "" then return nil end
	local index = buildInventoryIndex()
	return index.byId[itemId]
end

local function findInventoryUid(itemId)
	if not itemId or itemId == "" then return nil end
	local index = buildInventoryIndex()
	return index.uidById[itemId]
end

local function getBucketIds(bucketName)
	local index = buildInventoryIndex()
	return index.bucketIds[bucketName] or {}
end

-- -----------------------------------------------------
-- DIRECTORY CACHE
-- -----------------------------------------------------
local DirectoryCache = {}

local function getDirectoryIds(folderName)
	local cached = DirectoryCache[folderName]
	if cached then return cached end
	local ids = {}
	local folder = directFolder and directFolder:FindFirstChild(folderName)
	if folder then
		for _, child in ipairs(folder:GetChildren()) do
			local id
			local ok, data = pcall(require, child)
			if ok and typeof(data) == "table" and data._id then
				id = data._id
			else
				local parts = string.split(child.Name, " | ")
				id = parts[2] or child.Name
			end
			if id and id ~= "" then
				table.insert(ids, id)
			end
		end
		table.sort(ids)
	end
	DirectoryCache[folderName] = ids
	return ids
end

local function clearDirectoryCache()
	DirectoryCache = {}
end

-- -----------------------------------------------------
-- EGG ID CACHE
-- -----------------------------------------------------
local eggNumberCache = nil

local function getEggIdByNumber(eggNumber)
	if not eggNumberCache then
		eggNumberCache = {}
		for _, egg in pairs(Modules.EggsDir or {}) do
			if typeof(egg) == "table" and egg._id and egg.eggNumber then
				eggNumberCache[egg.eggNumber] = egg._id
			end
		end
	end
	return eggNumberCache[eggNumber]
end

local function getEggNumberById(eggId)
	if not eggNumberCache then getEggIdByNumber(0) end
	for num, id in pairs(eggNumberCache or {}) do
		if id == eggId then return num end
	end
	return nil
end

local function getMaxHatch()
	if Modules.EggCmds and Modules.EggCmds.GetMaxHatch then
		local ok, value = pcall(Modules.EggCmds.GetMaxHatch)
		if ok and typeof(value) == "number" and value > 0 then
			return value
		end
	end
	return 1
end

-- -----------------------------------------------------
-- ZONE CACHE
-- -----------------------------------------------------
local ZoneCache = { data = nil, timestamp = 0, ttl = 1 }

local function getCurrentZone()
	local now = os.clock()
	if ZoneCache.timestamp > 0 and (now - ZoneCache.timestamp) < ZoneCache.ttl then
		return ZoneCache.data
	end
	if Modules.MapCmds and Modules.MapCmds.GetCurrentZone then
		local ok, zone = pcall(Modules.MapCmds.GetCurrentZone)
		if ok then
			ZoneCache.data = zone
			ZoneCache.timestamp = now
			return zone
		end
	end
	return nil
end

local function getInstanceInfo()
	if Modules.MapCmds and Modules.MapCmds.GetCurrentInstanceInfo then
		local ok, info = pcall(Modules.MapCmds.GetCurrentInstanceInfo)
		if ok and typeof(info) == "table" then
			return info
		end
	end
	return nil
end

-- -----------------------------------------------------
-- Webhook
-- -----------------------------------------------------
local function sendWebhook(url, payload)
	if not url or url == "" then return false end
	local clean, issues = reqCheck()
	if not clean then
		warn("[VRT] Webhook bị skip, request có vấn đề:", table.concat(issues, ","))
		return false
	end
	local ok, body = pcall(httpService.JSONEncode, httpService, payload)
	if not ok then return false end
	return pcall(function()
		httpRequest({
			Url = url,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = body,
		})
	end)
end

local function sendExecutionWebhook()
	if not settings.WebhookEnabled or settings.WebhookUrl == "" then return end
	local executorName, executorVersion = "Unknown", ""
	pcall(function()
		local a, b = identifyexecutor()
		executorName = a or "Unknown"
		executorVersion = b or ""
	end)
	local gameName = "Unknown"
	pcall(function()
		gameName = marketplaceService:GetProductInfo(game.PlaceId, Enum.InfoType.Asset).Name
	end)
	sendWebhook(settings.WebhookUrl, {
		embeds = {
			{
				title = "VRT PS99 — Script Executed",
				color = 3447003,
				fields = {
					{ name = "Player", value = localPlayer.Name, inline = true },
					{ name = "Display Name", value = localPlayer.DisplayName, inline = true },
					{ name = "User ID", value = tostring(localPlayer.UserId), inline = true },
					{ name = "Account Age", value = tostring(localPlayer.AccountAge) .. " days", inline = true },
					{ name = "Place ID", value = tostring(game.PlaceId), inline = true },
					{ name = "Game Name", value = gameName, inline = false },
					{ name = "Execution Time", value = os.date("%c"), inline = false },
					{ name = "Executor", value = (tostring(executorName) .. " " .. tostring(executorVersion)):gsub("%s+$", ""), inline = true },
					{ name = "Script Version", value = vrt.Version, inline = true },
					{ name = "AC Bypass", value = AntiCheat.active and "active" or "inactive", inline = true },
				},
				footer = { text = "VRT PS99 — v" .. vrt.Version },
			},
		},
	})
end

-- -----------------------------------------------------
-- Hide Egg Anim (RenderStepped — max frequency)
-- -----------------------------------------------------
vrt.eggGuiConnections = {}

local function hideEggGuis()
	local playerGui = localPlayer:FindFirstChild("PlayerGui")
	if not playerGui then return end
	local target = playerGui:FindFirstChild("EggOpenAnimation")
	if target and target:IsA("ScreenGui") then
		if target.Enabled then
			target.Enabled = false
		end
	end
	for _, name in ipairs({ "HatchSettings", "LootMessage" }) do
		local gui = playerGui:FindFirstChild(name)
		if gui and gui:IsA("ScreenGui") and gui.Enabled then
			gui.Enabled = false
		end
	end
end

vrt.hideEggConnection = runService.RenderStepped:Connect(function()
	if not getgenv().VRT_LOADED then return end
	if not settings.HideEggAnim then return end
	local playerGui = localPlayer:FindFirstChild("PlayerGui")
	if not playerGui then return end
	local target = playerGui:FindFirstChild("EggOpenAnimation")
	if target and target:IsA("ScreenGui") and target.Enabled then
		target.Enabled = false
	end
end)

-- -----------------------------------------------------
-- EGG ANIMATION HOOK (kiểu 25MS: gán PlayEggAnimation + Message.Bottom)
-- -----------------------------------------------------
local eggHookState = {
	frontend = nil,
	script = nil,
	path = nil,
	funcName = nil,
	hook = nil,
	callOriginal = nil,
	message = nil,
	warned = false,
	thread = nil,
}

local function isMessageModule(value)
	return typeof(value) == "table" and typeof(value.Bottom) == "function"
end

-- Lấy Message.Bottom gốc của game (giống 25MS).
local function resolveGameMessage()
	if eggHookState.message then return eggHookState.message end

	local direct = safeRequire(clientFolder:FindFirstChild("Message"))
	if isMessageModule(direct) then
		eggHookState.message = direct
		print("[VRT] Message.Bottom: Library.Client.Message")
		return direct
	end

	local library = safeRequire(libraryFolder)
	local nested = typeof(library) == "table" and library.Message or nil
	if isMessageModule(nested) then
		eggHookState.message = nested
		print("[VRT] Message.Bottom: Library.Message")
		return nested
	end
	return nil
end

local function pushEggMessage(eggName)
	local message = resolveGameMessage()
	if not message then
		if not eggHookState.warned then
			eggHookState.warned = true
			warn("[VRT] Không tìm thấy Message.Bottom, dùng animation gốc.")
		end
		return false
	end

	local color = Color3.fromRGB(math.random(0, 255), math.random(0, 255), math.random(0, 255))
	local text = "Still Openin " .. tostring(eggName) .. " " .. tostring(getMaxHatch())
	pcall(setthreadidentity, 4)
	return (pcall(message.Bottom, { Message = text, Color = color }))
end

local function onEggAnimation(eggName, ...)
	if settings.HideEggAnim then pcall(hideEggGuis) end
	if settings.HookEggAnimation and pushEggMessage(eggName) then
		return
	end
	local call = eggHookState.callOriginal
	if call then
		return call(eggName, ...)
	end
end

local FRONTEND_PATHS = {
	{ "PlayerScripts", "Scripts", "Game", "Egg Opening Frontend" },
	{ "PlayerScripts", "Scripts", "Core", "Egg Opening Frontend" },
	{ "PlayerScripts", "PlayerModule", "Egg Opening Frontend" },
}

local function findEggFrontend()
	for _, path in ipairs(FRONTEND_PATHS) do
		local node = localPlayer
		for _, name in ipairs(path) do
			node = node and node:FindFirstChild(name)
		end
		if node then
			local ok, env = pcall(getsenv, node)
			if ok and typeof(env) == "table" then
				eggHookState.frontend = env
				eggHookState.script = node
				eggHookState.path = table.concat(path, ".")
				return true
			end
		end
	end
	return false
end

local function scanForFrontend()
	local playerScripts = localPlayer:FindFirstChild("PlayerScripts")
	if not playerScripts then return false end
	for _, script in ipairs(playerScripts:GetDescendants()) do
		if script:IsA("LocalScript") or script:IsA("ModuleScript") then
			local ok, env = pcall(getsenv, script)
			if ok and typeof(env) == "table" then
				for name, value in pairs(env) do
					if typeof(name) == "string" and typeof(value) == "function"
						and (name:lower():find("playegg") or name:lower():find("egganim"))
					then
						eggHookState.frontend = env
						eggHookState.script = script
						eggHookState.path = "scan:" .. script.Name .. "." .. name
						return true
					end
				end
			end
		end
	end
	return false
end

local function applyEggHook()
	if not hasFn(getsenv) then
		if not eggHookState.warnedNoSenv then
			eggHookState.warnedNoSenv = true
			warn("[VRT] Executor không có getsenv, tắt Hook Egg Animation (Hide Egg Anim vẫn chạy).")
		end
		return false
	end
	if not eggHookState.script or not eggHookState.script.Parent then
		eggHookState.frontend = nil
		eggHookState.script = nil
		eggHookState.funcName = nil
	end

	if not eggHookState.frontend then
		if not findEggFrontend() and not scanForFrontend() then return false end
	end

	local okEnv, freshEnv = pcall(getsenv, eggHookState.script)
	if okEnv and typeof(freshEnv) == "table" and freshEnv ~= eggHookState.frontend then
		eggHookState.frontend = freshEnv
		eggHookState.funcName = nil
	end

	local env = eggHookState.frontend
	if not env then return false end

	local funcName = eggHookState.funcName
	if not funcName or typeof(env[funcName]) ~= "function" then
		funcName = nil
		for _, name in ipairs({ "PlayEggAnimation", "PlayAnimation", "PlayEgg", "PlayHatch" }) do
			if typeof(env[name]) == "function" then
				funcName = name
				break
			end
		end
		if not funcName then
			for name, value in pairs(env) do
				if typeof(name) == "string" and typeof(value) == "function"
					and (name:lower():find("playegg") or name:lower():find("egganim"))
				then
					funcName = name
					break
				end
			end
		end
	end
	if not funcName then return false end
	eggHookState.funcName = funcName

	if not eggHookState.hook then
		pcall(setstackhidden, onEggAnimation, true)
		pcall(debug.setinfo, onEggAnimation, "s", "[C]")
		pcall(debug.setinfo, onEggAnimation, "n", "")
		eggHookState.hook = onEggAnimation
	end

	local current = env[funcName]
	if current == eggHookState.hook then return true end

	-- Cache bản gốc rồi gán hook trực tiếp vào env (giống 25MS).
	eggHookState.callOriginal = current
	local ok = pcall(function() env[funcName] = eggHookState.hook end)
	return ok
end

local function installEggHook()
	if not eggHookState.frontend then
		if not findEggFrontend() then scanForFrontend() end
	end
	return applyEggHook()
end

local function startEggHookLoop()
	if eggHookState.thread then return end
	eggHookState.thread = task.spawn(function()
		while getgenv().VRT_LOADED do
			if settings.HookEggAnimation or settings.HideEggAnim then
				pcall(applyEggHook)
				task.wait(0.1)
			else
				task.wait(0.5)
			end
		end
		eggHookState.thread = nil
	end)
end

localPlayer.CharacterAdded:Connect(function()
	task.defer(function()
		task.wait(1)
		eggHookState.frontend = nil
		eggHookState.script = nil
		eggHookState.funcName = nil
		if settings.HookEggAnimation or settings.HideEggAnim then
			pcall(installEggHook)
		end
	end)
end)

task.spawn(function()
	for _ = 1, 10 do
		if eggHookState.frontend then break end
		if not findEggFrontend() then scanForFrontend() end
		task.wait(1)
	end
	startEggHookLoop()
end)

-- -----------------------------------------------------
-- Helpers.
-- -----------------------------------------------------
local function getRoot()
	local character = localPlayer.Character
	return character and character:FindFirstChild("HumanoidRootPart") or nil
end

local function getBreakableFolder()
	local things = workspace:FindFirstChild("__THINGS")
	return things and things:FindFirstChild("Breakables") or nil
end

local function getOwnedPetUids()
	local uids = {}
	if Modules.PlayerPet and Modules.PlayerPet.GetAll then
		local ok, pets = pcall(Modules.PlayerPet.GetAll)
		if ok and typeof(pets) == "table" then
			for _, pet in pairs(pets) do
				if typeof(pet) == "table" and pet.owner == localPlayer then
					local uid = pet.euid or pet.uid
					if uid then table.insert(uids, uid) end
				end
			end
		end
	end
	return uids
end

local function getDmMountain()
	local things = workspace:FindFirstChild("__THINGS")
	local container = things and things:FindFirstChild("__INSTANCE_CONTAINER")
	local active = container and container:FindFirstChild("Active")
	return active and active:FindFirstChild("DiamondMountain")
end

local function getBreakZones()
	local mountain = getDmMountain()
	return mountain and mountain:FindFirstChild("BREAK_ZONES")
end

-- -----------------------------------------------------
-- BREAKABLE POSITIONS
-- -----------------------------------------------------
local BreakablePositions = { data = nil, timestamp = 0, ttl = 2 }
local breakablePositionCache = setmetatable({}, { __mode = "k" })

local function getBreakablePositions()
	local now = os.clock()
	if BreakablePositions.data and (now - BreakablePositions.timestamp) < BreakablePositions.ttl then
		return BreakablePositions.data
	end
	local folder = getBreakableFolder()
	if not folder then return {} end
	local list = {}
	for _, model in ipairs(folder:GetChildren()) do
		if model:IsA("Model") then
			local cached = breakablePositionCache[model]
			if not cached then
				local ok, pivot = pcall(function() return model.WorldPivot end)
				if ok and pivot then
					cached = {
						position = pivot.Position,
						parentId = model:GetAttribute("ParentID"),
					}
					breakablePositionCache[model] = cached
				end
			end
			if cached then
				table.insert(list, {
					name = model.Name,
					position = cached.position,
					parentId = cached.parentId,
				})
			end
		end
	end
	BreakablePositions.data = list
	BreakablePositions.timestamp = now
	return list
end

-- -----------------------------------------------------
-- EGG POSITIONS
-- -----------------------------------------------------
local EggPositions = { data = nil, timestamp = 0, ttl = 2 }
local eggPositionCache = setmetatable({}, { __mode = "k" })

local function getEggPositions()
	local now = os.clock()
	if EggPositions.data and (now - EggPositions.timestamp) < EggPositions.ttl then
		return EggPositions.data
	end
	local things = workspace:FindFirstChild("__THINGS")
	if not things then return {} end
	local worldName
	if Modules.WorldsUtil and Modules.WorldsUtil.GetEggsModelName then
		local ok, name = pcall(Modules.WorldsUtil.GetEggsModelName)
		worldName = ok and name or nil
	end
	if not worldName then return {} end
	local list = {}
	local function scanContainer(container)
		if not container then return end
		for _, model in ipairs(container:GetChildren()) do
			if model:IsA("Model") then
				local cached = eggPositionCache[model]
				if not cached then
					local eggNumber = tonumber(model.Name:match("^(%d+)"))
					if eggNumber and getEggIdByNumber(eggNumber) then
						local light = model:FindFirstChild("Light")
						local position
						if light then
							position = light.CFrame.Position
						else
							local ok, pivot = pcall(function() return model.WorldPivot end)
							position = ok and pivot.Position or nil
						end
						if position then
							cached = { eggNumber = eggNumber, position = position }
							eggPositionCache[model] = cached
						end
					end
				end
				if cached then
					table.insert(list, cached)
				end
			end
		end
	end
	local zoneEggs = things:FindFirstChild("ZoneEggs")
	if zoneEggs and zoneEggs:FindFirstChild(worldName) then
		scanContainer(zoneEggs[worldName])
	end
	local eggs = things:FindFirstChild("Eggs")
	if eggs and eggs:FindFirstChild(worldName) then
		scanContainer(eggs[worldName])
	end
	EggPositions.data = list
	EggPositions.timestamp = now
	return list
end

-- -----------------------------------------------------
-- Dropdown memoize
-- -----------------------------------------------------
local DerivedCache = {}
local DERIVED_TTL = 5

local function memoize(key, fn)
	local entry = DerivedCache[key]
	local now = os.clock()
	if entry and (now - entry.timestamp) < DERIVED_TTL then
		return entry.value
	end
	local value = fn()
	DerivedCache[key] = { value = value, timestamp = now }
	return value
end

local function clearDerivedCache()
	DerivedCache = {}
end

local function getChestNames()
	return memoize("chests", function()
		local names, seen = {}, {}
		local miscIds = getBucketIds("Misc")
		for _, id in ipairs(miscIds) do
			local base = id:match("^(.+) Lower Half$")
			if base then
				local chestName = base:gsub("%s*Key$", "") .. " Chest"
				if not seen[chestName] then
					seen[chestName] = true
					table.insert(names, chestName)
				end
			end
		end
		table.sort(names)
		return names
	end)
end

local GIFT_BAG_NAMES = {
	["Gift Bag"] = true,
	["Large Gift Bag"] = true,
	["Diamond Gift Bag"] = true,
	["Global Event Gift"] = true,
	["Free Gift Bag"] = true,
	["Party Box"] = true,
}

local function isGiftBagId(id)
	if GIFT_BAG_NAMES[id] then return true end
	if id:find("Gift Bag", 1, true) then return true end
	return false
end

local function getGiftIds()
	return memoize("gifts", function()
		local gifts, seen = {}, {}
		local misc = directFolder and directFolder:FindFirstChild("MiscItems")
		local categorized = misc and misc:FindFirstChild("Categorized")
		local giftsFolder = categorized and categorized:FindFirstChild("Gifts")
		if giftsFolder then
			for _, child in ipairs(giftsFolder:GetChildren()) do
				local id
				local ok, data = pcall(require, child)
				if ok and typeof(data) == "table" and data._id then
					id = data._id
				else
					local parts = string.split(child.Name, " | ")
					id = parts[2] or child.Name
				end
				if id and id ~= "" and not seen[id] then
					seen[id] = true
					table.insert(gifts, id)
				end
			end
		end
		if #gifts == 0 then
			for _, id in ipairs(getBucketIds("Misc")) do
				if isGiftBagId(id) and not seen[id] then
					seen[id] = true
					table.insert(gifts, id)
				end
			end
		end
		table.sort(gifts)
		return gifts
	end)
end

local function getLibraryDirIds(folderName)
	local ids, seen = {}, {}
	local folder = directoryFolder and directoryFolder:FindFirstChild(folderName)
	if folder then
		for _, child in ipairs(folder:GetChildren()) do
			local id
			local ok, data = pcall(require, child)
			if ok and typeof(data) == "table" and data._id then
				id = data._id
			else
				id = child.Name
			end
			if id and id ~= "" and not seen[id] then
				seen[id] = true
				table.insert(ids, id)
			end
		end
		table.sort(ids)
	end
	return ids
end

local function getLootboxIds()
	return memoize("lootboxes", function()
		local list, seen = {}, {}
		local function addAll(src)
			if typeof(src) ~= "table" then return end
			for _, id in ipairs(src) do
				if id and id ~= "" and not seen[id] then
					seen[id] = true
					table.insert(list, id)
				end
			end
		end
		addAll(getLibraryDirIds("Lootboxes"))
		addAll(getDirectoryIds("Lootboxes"))
		addAll(getBucketIds("Lootbox"))
		table.sort(list)
		return list
	end)
end

local function getEnchantRarities()
	return memoize("rarities", function()
		local rarities, seen = {}, {}
		local save = getSaveCached()
		if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Enchant then
			return rarities
		end
		for _, entry in pairs(save.Inventory.Enchant) do
			if typeof(entry) == "table" then
				local rarity = tostring(entry.rn or entry.rarity or "Unknown")
				if not seen[rarity] then
					seen[rarity] = true
					table.insert(rarities, rarity)
				end
			end
		end
		table.sort(rarities)
		return rarities
	end)
end

local function getEggIdList()
	return memoize("eggIds", function()
		local ids = {}
		for _, egg in pairs(Modules.EggsDir or {}) do
			if typeof(egg) == "table" and egg._id then
				table.insert(ids, egg._id)
			end
		end
		table.sort(ids)
		return ids
	end)
end

local function getCustomEggOptions()
	return memoize("customEggs", function()
		local options = {}
		vrt.customEggMap = {}
		local cmds = Modules.CustomEggsCmds
		if cmds and typeof(cmds.All) == "function" then
			local ok, data = pcall(cmds.All)
			if ok and typeof(data) == "table" then
				for uid, egg in pairs(data) do
					if typeof(egg) == "table" and egg._hatchable == true then
						local name = egg._id or egg.name or uid
						local display = name .. " | " .. tostring(uid):sub(1, 8)
						vrt.customEggMap[display] = {
							uid = uid,
							name = name,
							position = egg._position,
						}
						table.insert(options, display)
					end
				end
			end
		end
		table.sort(options)
		return options
	end)
end

local function resolveSelection(selected, allOptions)
	if typeof(selected) ~= "table" or #selected == 0 then
		return allOptions
	end
	if table.find(selected, "All") then
		return allOptions
	end
	return selected
end

local function buildOptions(list)
	local options = { "All" }
	for _, name in ipairs(list) do
		if not table.find(options, name) then
			table.insert(options, name)
		end
	end
	return options
end

local function generateRandomString(length)
	local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	local out = {}
	for _ = 1, length do
		local index = math.random(1, #chars)
		table.insert(out, chars:sub(index, index))
	end
	return table.concat(out)
end

-- -----------------------------------------------------
-- Anti-AFK
-- -----------------------------------------------------
task.spawn(function()
	if getgenv().VRT_AntiAFK then return end
	getgenv().VRT_AntiAFK = true
	local function kill(signal)
		local ok, conns = pcall(getconnections, signal)
		if not ok or typeof(conns) ~= "table" then return end
		for _, connection in pairs(conns) do
			pcall(function()
				if connection.Disable then
					connection:Disable()
				elseif connection.Disconnect then
					connection:Disconnect()
				end
			end)
		end
	end
	kill(localPlayer.Idled)
	kill(userInputService.WindowFocusReleased)
	kill(userInputService.WindowFocused)
	task.spawn(function()
		local scripts = localPlayer:WaitForChild("PlayerScripts", 10)
		local scriptsFolder = scripts and scripts:WaitForChild("Scripts", 10)
		local coreFolder = scriptsFolder and scriptsFolder:WaitForChild("Core", 10)
		local idleScript = coreFolder and coreFolder:WaitForChild("Idle Tracking", 10)
		if idleScript then
			pcall(function() idleScript.Enabled = false end)
		end
	end)
	fire("Idle Tracking: Stop Timer")
	local ok, virtualUser = pcall(game.GetService, game, "VirtualUser")
	if not ok or not virtualUser then return end
	-- Fallback chuẩn cho executor mobile không có getconnections.
	if vrt.idledConnection then
		pcall(function() vrt.idledConnection:Disconnect() end)
	end
	vrt.idledConnection = localPlayer.Idled:Connect(function()
		if not getgenv().VRT_LOADED then return end
		pcall(function()
			virtualUser:CaptureController()
			virtualUser:ClickButton2(Vector2.new(0, 0))
		end)
	end)
	while getgenv().VRT_LOADED do
		pcall(function()
			virtualUser:Button2Up(Vector2.new(0, 0))
		end)
		fire("Idle Tracking: Update Timer", 10)
		fire("Idle Tracking: Stop Timer")
		task.wait(280 + math.random() * 40)
	end
end)

-- -----------------------------------------------------
-- Core
-- -----------------------------------------------------
local Core = {}

local closestBuffer = {}
local petDataBuffer = {}

Core.FastFarm = function()
	local root = getRoot()
	if not root then return end
	if settings.UseFarmPoint and typeof(settings.FarmPoint) == "table" then
		local fp = settings.FarmPoint
		if fp.x and fp.y and fp.z then
			local targetPos = Vector3.new(fp.x, fp.y, fp.z)
			if (root.Position - targetPos).Magnitude > 15 then
				root.CFrame = CFrame.new(targetPos)
				return
			end
		end
	end
	local rootPos = root.Position
	local zone = getCurrentZone()
	local breakables = getBreakablePositions()
	table.clear(closestBuffer)
	for _, item in ipairs(breakables) do
		if item.parentId == nil or item.parentId == zone then
			if (item.position - rootPos).Magnitude < 85 then
				table.insert(closestBuffer, item.name)
			end
		end
	end
	local breakableCount = #closestBuffer
	if breakableCount == 0 then return end
	local uids = getOwnedPetUids()
	if #uids == 0 then return end
	table.clear(petDataBuffer)
	for _, uid in ipairs(uids) do
		petDataBuffer[uid] = closestBuffer[math.random(1, breakableCount)]
	end
	fire("Breakables_JoinPetBulk", petDataBuffer)
end

Core.CollectOrbs = function()
	local things = workspace:FindFirstChild("__THINGS")
	local orbs = things and things:FindFirstChild("Orbs")
	if not orbs then return end
	for _, orb in ipairs(orbs:GetChildren()) do
		local orbId = tonumber(orb.Name)
		if orbId then
			fire("Orbs: Collect", { orbId })
			orb:Destroy()
		end
	end
end

local clickAuraCache = { names = {}, rootPos = nil, timestamp = 0, ttl = 0.08 }

Core.ClickAura = function()
	local root = getRoot()
	if not root then return end
	local rootPos = root.Position
	local radius = settings.ClickAuraRadius
	local radiusSq = radius * radius
	local now = os.clock()
	local cache = clickAuraCache
	local stale = (now - cache.timestamp) > cache.ttl
	local movedFar = cache.rootPos and (cache.rootPos - rootPos).Magnitude > 8
	if stale or movedFar then
		local breakables = getBreakablePositions()
		local names = {}
		for _, item in ipairs(breakables) do
			local dx = item.position.X - rootPos.X
			local dy = item.position.Y - rootPos.Y
			local dz = item.position.Z - rootPos.Z
			if dx * dx + dy * dy + dz * dz <= radiusSq then
				names[#names + 1] = item.name
			end
		end
		cache.names = names
		cache.rootPos = rootPos
		cache.timestamp = now
	end
	for _, name in ipairs(cache.names) do
		unreliable("Breakables_PlayerDealDamage", name)
	end
end

Core.ClickAuraViz = function()
	local root = getRoot()
	if not root then return end
	local viz = workspace:FindFirstChild("M")
	if not settings.ClickAuraViz then
		if viz then viz:Destroy() end
		return
	end
	if not viz then
		viz = Instance.new("Part")
		viz.Name = "M"
		viz.Anchored = true
		viz.CanCollide = false
		viz.CanQuery = false
		viz.CanTouch = false
		viz.Shape = Enum.PartType.Cylinder
		viz.Material = Enum.Material.Neon
		viz.BrickColor = BrickColor.new("Light green (Mint)")
		viz.Transparency = 0.5
		viz.Parent = workspace
	end
	local radius = settings.ClickAuraRadius
	viz.Size = Vector3.new(0.2, radius * 2, radius * 2)
	viz.CFrame = CFrame.new(root.Position) * VIZ_ROTATION
end

local function hatchCustomEgg(uuid)
	if not uuid or uuid == "" then return 0 end
	local maxHatch = getMaxHatch()

	local okBatch, result = invoke("CustomEggs_Hatch", uuid, maxHatch)
	if okBatch and result == true then
		return maxHatch
	end

	local total = 0
	for i = 1, maxHatch do
		local ok = invoke("CustomEggs_Hatch", uuid)
		if not ok then break end
		total += 1
		if i < maxHatch then task.wait(0.08) end
	end
	return total
end

Core.OpenEgg = function()
	local root = getRoot()
	if not root then return end
	local rootPos = root.Position

	local customEgg, customDist = nil, math.huge
	local cmds = Modules.CustomEggsCmds
	if cmds and typeof(cmds.All) == "function" then
		local ok, list = pcall(cmds.All)
		if ok and typeof(list) == "table" then
			for uid, egg in pairs(list) do
				if typeof(egg) == "table" and egg._hatchable == true and egg._position then
					local d = (egg._position - rootPos).Magnitude
					if d < customDist then
						customEgg, customDist = uid, d
					end
				end
			end
		end
	end

	local normalEgg, normalDist = nil, math.huge
	local eggs = getEggPositions()
	for _, egg in ipairs(eggs) do
		local d = (egg.position - rootPos).Magnitude
		if d < normalDist then
			normalEgg, normalDist = egg, d
		end
	end

	if not customEgg and not normalEgg then return end

	if customEgg and customDist <= normalDist then
		hatchCustomEgg(customEgg)
	elseif normalEgg then
		local eggId = getEggIdByNumber(normalEgg.eggNumber)
		if not eggId then return end
		invoke("Eggs_RequestPurchase", eggId, getMaxHatch())
	end
end

Core.OpenSelectedEgg = function()
	local eggId = settings.SelectedEggId
	if not eggId or eggId == "" then return end
	invoke("Eggs_RequestPurchase", eggId, getMaxHatch())
end

Core.BuySelectedCustomEgg = function()
	local uuid = settings.SelectedCustomEggUuid
	if not uuid or uuid == "" then return end
	hatchCustomEgg(uuid)
end

Core.InfinitePetSpeed = function(enabled)
	if not Modules.PlayerPet or not Modules.PlayerPet.CalculateSpeedMultiplier then
		return
	end
	if enabled then
		vrt.originalPetSpeed = vrt.originalPetSpeed or Modules.PlayerPet.CalculateSpeedMultiplier
		Modules.PlayerPet.CalculateSpeedMultiplier = function()
			return math.huge
		end
	elseif vrt.originalPetSpeed then
		Modules.PlayerPet.CalculateSpeedMultiplier = vrt.originalPetSpeed
	end
end

local optimizedPets = setmetatable({}, { __mode = "k" })

Core.OptimizePets = function()
	local things = workspace:FindFirstChild("__THINGS")
	local petsFolder = things and things:FindFirstChild("Pets")
	if not petsFolder then return end
	for _, pet in ipairs(petsFolder:GetChildren()) do
		if not optimizedPets[pet] then
			optimizedPets[pet] = true
			for _, descendant in ipairs(pet:GetDescendants()) do
				if descendant:IsA("Part") then
					descendant.Material = OPTIMIZE_MATERIAL
					descendant.Size = OPTIMIZE_SIZE
				elseif descendant:IsA("SpecialMesh")
					or descendant:IsA("ParticleEmitter")
					or descendant:IsA("MeshPart")
					or descendant:IsA("Decal")
				then
					descendant:Destroy()
				end
			end
		end
	end
end

Core.OptimizeBreakables = function()
	if vrt.optimizeConnection then return end
	local debrisFolder = workspace:FindFirstChild("__DEBRIS")
	if not debrisFolder then return end
	vrt.optimizeConnection = debrisFolder.ChildAdded:Connect(function(child)
		pcall(function()
			debrisService:AddItem(child, 0)
		end)
	end)
end

local ANTILAG_KILL = {
	ParticleEmitter = true, Beam = true, Trail = true, Smoke = true,
	Fire = true, Sparkles = true, Explosion = true, Sound = true,
	PointLight = true, SpotLight = true, SurfaceLight = true,
}

local antiLagState = { conn = nil, seen = setmetatable({}, { __mode = "k" }) }

local function antiLagStrip(descendant)
	if antiLagState.seen[descendant] then return false end
	local class = descendant.ClassName
	if ANTILAG_KILL[class] then
		antiLagState.seen[descendant] = true
		pcall(function() descendant:Destroy() end)
		return true
	elseif descendant:IsA("Texture") or descendant:IsA("Decal") then
		antiLagState.seen[descendant] = true
		pcall(function() descendant.Transparency = 1 end)
		return true
	elseif descendant:IsA("SurfaceAppearance") then
		antiLagState.seen[descendant] = true
		pcall(function() descendant:Destroy() end)
		return true
	elseif descendant:IsA("BasePart") then
		antiLagState.seen[descendant] = true
		pcall(function()
			descendant.Material = Enum.Material.SmoothPlastic
			descendant.Reflectance = 0
			descendant.CastShadow = false
		end)
		return true
	end
	return false
end

local function antiLagCrushGraphics()
	pcall(function()
		local lighting = game:GetService("Lighting")
		lighting.FogEnd = 9e9
		lighting.GlobalShadows = false
		lighting.EnvironmentDiffuseScale = 0
		lighting.EnvironmentSpecularScale = 0
		for _, child in ipairs(lighting:GetChildren()) do
			if child:IsA("PostEffect") or child:IsA("Atmosphere")
				or child:IsA("Clouds") or child:IsA("Sky")
			then
				pcall(function() child:Destroy() end)
			end
		end
	end)
	pcall(function()
		local terrain = workspace:FindFirstChildOfClass("Terrain")
		if terrain then
			terrain.WaterWaveSize = 0
			terrain.WaterWaveSpeed = 0
			terrain.WaterReflectance = 0
			terrain.WaterTransparency = 1
			terrain.Decoration = false
		end
	end)
	pcall(function()
		settings().Rendering.QualityLevel = Enum.QualityLevel.Level01
	end)
	if typeof(setfpscap) == "function" then
		pcall(setfpscap, 1000)
	end
end

Core.AntiLag = function()
	local removed = 0
	for _, container in ipairs({ workspace:FindFirstChild("__THINGS"), workspace }) do
		if container then
			for _, descendant in ipairs(container:GetDescendants()) do
				if antiLagStrip(descendant) then removed += 1 end
			end
		end
	end
	for _, player in ipairs(playersService:GetPlayers()) do
		local character = player.Character
		if character then
			for _, descendant in ipairs(character:GetDescendants()) do
				antiLagStrip(descendant)
			end
		end
	end
	antiLagCrushGraphics()
	if not antiLagState.conn then
		antiLagState.conn = workspace.DescendantAdded:Connect(function(descendant)
			if settings.AntiLag then
				task.defer(antiLagStrip, descendant)
			end
		end)
	end
	return removed
end

Core.StopAntiLag = function()
	if antiLagState.conn then
		pcall(function() antiLagState.conn:Disconnect() end)
		antiLagState.conn = nil
	end
	table.clear(antiLagState.seen)
	if typeof(setfpscap) == "function" then
		pcall(setfpscap, 0)
	end
end

Core.Daycare = function()
	local daycare = Modules.DaycareCmds
	if not daycare then return end
	local save = getSaveCached()
	if save and typeof(save.DaycareActive) == "table" and daycare.Claim then
		for uid in pairs(save.DaycareActive) do
			local ok, pet = pcall(daycare.Claim, uid)
			if ok and pet then
				invalidateSaveCache()
				return
			end
		end
	end
	if not daycare.GetMaxSlots or not daycare.GetUsedSlots then return end
	local okMax, maxSlots = pcall(daycare.GetMaxSlots)
	local okUsed, usedSlots = pcall(daycare.GetUsedSlots)
	if not okMax or not okUsed or not maxSlots or not usedSlots or usedSlots >= maxSlots then
		return
	end
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Pet then
		return
	end
	local sorted = {}
	local count = 0
	for uid, petEntry in pairs(save.Inventory.Pet) do
		count += 1
		if count % 100 == 0 then task.wait() end
		if typeof(petEntry) == "table" then
			local power = 0
			if Modules.Items and Modules.Items.Pet and Modules.Items.Pet.From then
				local ok, instance = pcall(Modules.Items.Pet.From, Modules.Items.Pet, petEntry)
				if ok and instance and instance.CalculatePower then
					local okPower, value = pcall(instance.CalculatePower, instance)
					power = (okPower and value) or 0
				end
			end
			table.insert(sorted, { uid = uid, power = power })
		end
	end
	table.sort(sorted, function(a, b) return a.power > b.power end)
	local enroll = {}
	for index = 1, math.min(maxSlots - usedSlots, #sorted) do
		enroll[sorted[index].uid] = 1
	end
	if not next(enroll) then return end
	if daycare.Enroll then
		local ok = pcall(daycare.Enroll, enroll)
		if ok then invalidateSaveCache() end
	else
		invoke("Daycare: Enroll", enroll)
	end
end

Core.BuyPetSlots = function()
	local save = getSaveCached()
	if not save or not Modules.PetEquipCmds or not Modules.PetEquipCmds.GetStatus then
		return
	end
	local purchased = save.PetSlotsPurchased or 0
	local ok, status = pcall(Modules.PetEquipCmds.GetStatus, purchased + 1)
	if ok and status == "NEXT" then
		invoke("EquipSlotsMachine_RequestPurchase", purchased + 1)
	end
end

local eggBundleCache = nil

Core.BuyEggSlots = function()
	local save = getSaveCached()
	if not save then return end
	local rankCmds = Modules.RankCmds
	if not rankCmds or not rankCmds.GetEggBundle then return end
	local purchased = save.EggSlotsPurchased or 0
	if not eggBundleCache then
		eggBundleCache = {}
		for index = 1, 200 do
			local okA, bundleEnd, bundleSize, prevEnd = pcall(function()
				return rankCmds.GetEggBundle(index)
			end)
			if not okA or not bundleEnd then break end
			table.insert(eggBundleCache, { bundleEnd = bundleEnd, prevEnd = prevEnd })
			if bundleEnd > 1000 then break end
		end
	end
	for _, bundle in ipairs(eggBundleCache) do
		if bundle.prevEnd == purchased then
			invoke("EggHatchSlotsMachine_RequestPurchase", bundle.bundleEnd)
			return
		end
	end
end

-- -----------------------------------------------------
-- FLAG (chỉ dùng khi trong zone, KHÔNG teleport)
-- -----------------------------------------------------
local flagAutoCache = {
	lastCheck = 0,
	lastConsume = 0,
	lastZone = nil,
	zoneLog = {},
	failLog = {},
}

local function resolveFlagId(displayName)
	if not displayName or displayName == "" then return nil end
	if findInventoryEntry(displayName) then return displayName end
	local base = displayName:gsub("%s*Flag$", "")
	for _, candidate in ipairs({ base, base .. " Flag", base .. "Flag", base .. "_Flag" }) do
		if findInventoryEntry(candidate) then return candidate end
	end
	return nil
end

local function getFlagGameMax(flagId)
	local flagCmds = Modules.FlexibleFlagCmds
	local root = getRoot()
	if not flagCmds or not root then return 45 end
	if typeof(flagCmds.GetMaxPlaceAutomaticContext) == "function" then
		local ok, value = pcall(flagCmds.GetMaxPlaceAutomaticContext, root.Position)
		if ok and typeof(value) == "number" and value > 0 then
			return value
		end
	end
	return 45
end

Core.GetFlagOwnedAmount = function(displayName)
	local resolvedId = resolveFlagId(displayName)
	if not resolvedId then return 0, nil end
	local entry = findInventoryEntry(resolvedId)
	return entry and (entry._am or 0) or 0, resolvedId
end

Core.GetFlagGameMax = function(flagId)
	return getFlagGameMax(flagId or settings.SelectedFlag)
end

Core.GetFlagMaxAmount = function(displayName)
	local owned = Core.GetFlagOwnedAmount(displayName)
	if owned <= 0 then return 0 end
	return math.min(owned, getFlagGameMax(displayName))
end

local function detectCurrentZone()
	local root = getRoot()
	if not root then return nil end

	local mapCmds = Modules.MapCmds
	if mapCmds and mapCmds.GetCurrentBreakZone then
		local ok, zone = pcall(mapCmds.GetCurrentBreakZone)
		if ok and zone then
			local zoneId = typeof(zone) == "table"
				and (zone.ZoneNumber or zone.Name or zone._id)
				or tostring(zone)
			local anchorPos = nil
			local breakZones = getBreakZones()
			if breakZones then
				local zoneNum = typeof(zone) == "table" and zone.ZoneNumber
				if zoneNum then
					local zonePart = breakZones:FindFirstChild("Zone" .. tostring(zoneNum))
					if zonePart and zonePart:IsA("BasePart") then
						anchorPos = zonePart.Position
					end
				end
				if not anchorPos and typeof(zoneId) == "string" then
					for _, zp in ipairs(breakZones:GetChildren()) do
						if zp:IsA("BasePart") and zp.Name == zoneId then
							anchorPos = zp.Position
							break
						end
					end
				end
			end
			return { id = tostring(zoneId), anchorPos = anchorPos, zone = zone }
		end
	end

	local breakZones = getBreakZones()
	if breakZones then
		for _, zonePart in ipairs(breakZones:GetChildren()) do
			if zonePart:IsA("BasePart") then
				local rel = zonePart.CFrame:PointToObjectSpace(root.Position)
				local halfX = math.max(zonePart.Size.X / 2, 1)
				local halfY = math.max(zonePart.Size.Y / 2, 1)
				local halfZ = math.max(zonePart.Size.Z / 2, 1)
				if math.abs(rel.X) <= halfX
					and math.abs(rel.Y) <= halfY
					and math.abs(rel.Z) <= halfZ then
					return {
						id = zonePart.Name,
						anchorPos = zonePart.Position,
						zone = zonePart,
					}
				end
			end
		end
	end

	return nil
end

local function checkZoneFlag(anchorPos)
	local flagCmds = Modules.FlexibleFlagCmds
	if not flagCmds or typeof(flagCmds.SpatialQuery) ~= "function" then
		return false, nil, nil, nil
	end
	if not anchorPos then return false, nil, nil, nil end
	local ok, ctx = pcall(flagCmds.SpatialQuery, anchorPos)
	if not ok or not ctx then return false, nil, nil, nil end
	local endTime = ctx.EndTime
	if typeof(endTime) == "number" and endTime > os.time() then
		return true, ctx.FlagId, endTime, ctx
	end
	return false, ctx.FlagId, endTime, ctx
end

local function tryConsumeFlagWithCtx(flagId, amount, ctx, pos)
	local flagCmds = Modules.FlexibleFlagCmds
	local zoneFlagCmds = Modules.ZoneFlagCmds
	local zoneFlagsDir = Modules.ZoneFlagsDir
	local root = getRoot()
	if not root then return false, "no root" end

	local info = getInstanceInfo()
	local instanceId = info and info.InstanceId
	local areaId = info and info.AreaId

	local attempts = {}
	local function try(label, fn, ...)
		local ok, result = pcall(fn, ...)
		local success = ok and result ~= false
		table.insert(attempts, { label = label, ok = ok, result = result, success = success })
		return success
	end

	local flagUid = findInventoryUid(flagId) or findInventoryUid(settings.SelectedFlag)
	if flagUid then
		if typeof(flagCmds) == "table" and typeof(flagCmds.Consume) == "function" then
			if try("flex-name-uid-amt", flagCmds.Consume, settings.SelectedFlag, flagUid, amount) then
				return true, "flex-name-uid-amt"
			end
			if flagId ~= settings.SelectedFlag
				and try("flex-id-uid-amt", flagCmds.Consume, flagId, flagUid, amount) then
				return true, "flex-id-uid-amt"
			end
		end
		if try("remote-name-uid-amt", function()
			return invoke("FlexibleFlags_Consume", settings.SelectedFlag, flagUid, amount)
		end) then
			return true, "remote-name-uid-amt"
		end
	end

	local function resolveFlagDir()
		if typeof(zoneFlagsDir) ~= "table" then return nil end
		local displayName = settings.SelectedFlag
		local dir = zoneFlagsDir[displayName] or zoneFlagsDir[flagId]
		if dir then return dir end
		for key, val in pairs(zoneFlagsDir) do
			if typeof(val) == "table" then
				if val._id == flagId or key == flagId or key == displayName
					or val.Name == displayName or val._id == displayName then
					return val
				end
			end
		end
		return nil
	end

	local placeCtx = nil
	if typeof(flagCmds) == "table" and typeof(flagCmds.GetMaxPlaceAutomaticContext) == "function" then
		local okc, c = pcall(flagCmds.GetMaxPlaceAutomaticContext, pos or root.Position)
		if okc then placeCtx = c end
	end

	if typeof(flagCmds) == "table" and typeof(flagCmds.ActivateFlag) == "function" then
		local flagDir = resolveFlagDir()
		if flagDir then
			if placeCtx ~= nil and try("activate-dir-placectx", flagCmds.ActivateFlag, flagDir, placeCtx) then
				return true, "activate-dir-placectx"
			end
			if try("activate-dir-amount", flagCmds.ActivateFlag, flagDir, amount) then
				return true, "activate-dir-amount"
			end
			if ctx and try("activate-dir-ctx", flagCmds.ActivateFlag, flagDir, ctx) then
				return true, "activate-dir-ctx"
			end
			if try("activate-dir-pos", flagCmds.ActivateFlag, flagDir, pos or root.Position) then
				return true, "activate-dir-pos"
			end
			if try("activate-dir-opts", flagCmds.ActivateFlag, flagDir, { Amount = amount }) then
				return true, "activate-dir-opts"
			end
			if try("activate-dir", flagCmds.ActivateFlag, flagDir) then
				return true, "activate-dir"
			end
		end
		if try("activate-name-amount", flagCmds.ActivateFlag, settings.SelectedFlag, amount) then
			return true, "activate-name-amount"
		end
		if try("activate-id-amount", flagCmds.ActivateFlag, flagId, amount) then
			return true, "activate-id-amount"
		end
	end

	if ctx and typeof(flagCmds) == "table" and flagCmds.Consume then
		if try("flex-ctx", flagCmds.Consume, flagId, amount, ctx) then
			return true, "flex-ctx"
		end
	end

	if typeof(flagCmds) == "table" and flagCmds.Consume then
		if try("flex-pos", flagCmds.Consume, flagId, amount, pos) then
			return true, "flex-pos"
		end
		if instanceId and try("flex-instanceId", flagCmds.Consume, flagId, amount, instanceId) then
			return true, "flex-instanceId"
		end
		if areaId and try("flex-areaId", flagCmds.Consume, flagId, amount, areaId) then
			return true, "flex-areaId"
		end
		if try("flex-2args", flagCmds.Consume, flagId, amount) then
			return true, "flex-2args"
		end
	end

	if typeof(zoneFlagCmds) == "table" and zoneFlagCmds.Consume then
		if ctx and try("zflex-ctx", zoneFlagCmds.Consume, flagId, amount, ctx) then
			return true, "zflex-ctx"
		end
		if try("zflex-pos", zoneFlagCmds.Consume, flagId, amount, pos) then
			return true, "zflex-pos"
		end
	end

	local activateDir = resolveFlagDir()
	if activateDir then
		if placeCtx ~= nil and try("fire-activate-dir-placectx", function()
			return fire("FlexibleFlags_Activate", activateDir, placeCtx)
		end) then
			return true, "fire-activate-dir-placectx"
		end
		if try("fire-activate-dir-amount", function()
			return fire("FlexibleFlags_Activate", activateDir, amount)
		end) then
			return true, "fire-activate-dir-amount"
		end
		if try("fire-activate-dir-pos", function()
			return fire("FlexibleFlags_Activate", activateDir, pos or root.Position)
		end) then
			return true, "fire-activate-dir-pos"
		end
	end
	if placeCtx ~= nil and try("fire-activate-name-placectx", function()
		return fire("FlexibleFlags_Activate", settings.SelectedFlag, placeCtx)
	end) then
		return true, "fire-activate-name-placectx"
	end
	if try("fire-activate-name-amount", function()
		return fire("FlexibleFlags_Activate", settings.SelectedFlag, amount)
	end) then
		return true, "fire-activate-name-amount"
	end

	if ctx and try("remote-ctx", function()
		return invoke("FlexibleFlags_Consume", flagId, amount, ctx)
	end) then
		return true, "remote-ctx"
	end
	if try("remote-pos", function()
		return invoke("FlexibleFlags_Consume", flagId, amount, pos)
	end) then
		return true, "remote-pos"
	end
	if try("remote-2args", function()
		return invoke("FlexibleFlags_Consume", flagId, amount)
	end) then
		return true, "remote-2args"
	end

	return false, attempts
end

Core.AutoUseFlag = function()
	local root = getRoot()
	if not root then return end

	local selectedFlag = settings.SelectedFlag
	local owned, resolvedId = Core.GetFlagOwnedAmount(selectedFlag)
	if not resolvedId or owned <= 0 then return end

	local amount = math.min(settings.FlagAmount or 45, owned, getFlagGameMax(resolvedId))
	if amount <= 0 then return end

	local zoneInfo = detectCurrentZone()
	local anchorPos = (zoneInfo and zoneInfo.anchorPos) or root.Position

	local hasFlag, _, _, ctx = checkZoneFlag(anchorPos)
	if hasFlag then return end

	local ok = tryConsumeFlagWithCtx(resolvedId, amount, ctx, anchorPos)
	if ok then
		invalidateSaveCache()
	end
end

-- -----------------------------------------------------
-- Other Core functions
-- -----------------------------------------------------
Core.BuyZone = function()
	local zoneUtil = Modules.ZonesUtil
	if zoneUtil and zoneUtil.GetMaxOwnedZone and zoneUtil.GetZoneFromNumber then
		local okMax, maxOwned = pcall(zoneUtil.GetMaxOwnedZone)
		if okMax and typeof(maxOwned) == "number" then
			local okZone, nextZone = pcall(zoneUtil.GetZoneFromNumber, maxOwned + 1)
			if okZone and typeof(nextZone) == "table" and nextZone.ZoneNumber then
				invoke("Zones_RequestPurchase", nextZone.ZoneNumber)
				return
			end
		end
	end
	if Modules.ZoneCmds and Modules.ZoneCmds.GetNextZone then
		local ok, nextZone = pcall(Modules.ZoneCmds.GetNextZone)
		if ok and typeof(nextZone) == "table" and nextZone.ZoneNumber then
			invoke("Zones_RequestPurchase", nextZone.ZoneNumber)
			return
		end
	end
	local save = getSaveCached()
	if not save or typeof(save.UnlockedZones) ~= "table" then return end
	local highest = 1
	for _, zone in pairs(save.UnlockedZones) do
		if typeof(zone) == "table" and zone.ZoneNumber and zone.ZoneNumber > highest then
			highest = zone.ZoneNumber
		end
	end
	invoke("Zones_RequestPurchase", highest + 1)
end

Core.Rebirth = function()
	local rebirthCmds = Modules.RebirthCmds
	if not rebirthCmds then return end
	if rebirthCmds.CanRebirth then
		local ok, can = pcall(rebirthCmds.CanRebirth)
		if not ok or not can then return end
	end
	if rebirthCmds.Rebirth then
		pcall(rebirthCmds.Rebirth)
	end
end

Core.UseUltimate = function()
	local ultimate = Modules.UltimateCmds
	if not ultimate or not ultimate.GetEquippedItem then return end
	local ok, equipped = pcall(ultimate.GetEquippedItem)
	if not ok or typeof(equipped) ~= "table" or not equipped._data then return end
	local itemId = equipped._data.id
	if ultimate.IsCharged then
		local okCharged, charged = pcall(ultimate.IsCharged, itemId)
		if not okCharged or not charged then return end
	end
	if ultimate.Activate then
		pcall(ultimate.Activate, itemId)
	else
		invoke("Ultimates: Activate", itemId)
	end
end

Core.ClaimFreeGifts = function()
	local save = getSaveCached()
	if not save or typeof(Modules.FreeGifts) ~= "table" then return end
	local redeemed = save.FreeGiftsRedeemed or {}
	for _, gift in pairs(Modules.FreeGifts) do
		if typeof(gift) == "table" and gift._id and not table.find(redeemed, gift._id) then
			invoke("Redeem Free Gift", gift._id)
			task.wait(1)
		end
	end
end

Core.ClaimRankRewards = function()
	local save = getSaveCached()
	if not save or typeof(Modules.Ranks) ~= "table" then return end
	local directory
	for _, rank in pairs(Modules.Ranks) do
		if typeof(rank) == "table" and rank.RankNumber == save.Rank then
			directory = rank
			break
		end
	end
	if not directory or typeof(directory.Rewards) ~= "table" then return end
	local stars = save.RankStars or 0
	local redeemed = save.RedeemedRankRewards or {}
	for rewardId, reward in pairs(directory.Rewards) do
		if typeof(reward) == "table" and reward.StarsRequired and reward.StarsRequired <= stars then
			if not redeemed[tostring(rewardId)] then
				fire("Ranks_ClaimReward", rewardId)
				task.wait(1)
			end
		end
	end
end

Core.MailboxClaimAll = function()
	invoke("Mailbox: Claim All")
end

Core.MailboxSendHuges = function()
	if settings.MailboxUsername == "" then return end
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Pet then
		return
	end
	if not vrt.sentHuges then vrt.sentHuges = {} end
	for uid, petEntry in pairs(save.Inventory.Pet) do
		if typeof(petEntry) == "table" and petEntry.id then
			if petEntry.id:match("Huge") or petEntry.id:match("Titanic") then
				if not vrt.sentHuges[uid] then
					invoke("Mailbox: Send", settings.MailboxUsername:lower(),
						"VRT " .. generateRandomString(8), "Pet", uid, petEntry._am or 1)
					vrt.sentHuges[uid] = true
					task.wait(1)
					if settings.MailboxHugeMode == "New" then break end
				end
			end
		end
	end
end

Core.CollectRelics = function()
	local ok, relicsScript = pcall(function()
		return localPlayer.PlayerScripts.Scripts.Game.Misc:FindFirstChild("Shiny Relics")
	end)
	if not ok or not relicsScript then return end
	if not hasFn(getsenv) or not hasFn(getUpvalue) then return end
	local okEnv, env = pcall(getsenv, relicsScript)
	if not okEnv or not env or not env.SetupRelics then return end
	local okUp, relicList = pcall(getUpvalue, env.SetupRelics, 7)
	if not okUp or typeof(relicList) ~= "table" then return end
	for _, relic in pairs(relicList) do
		if typeof(relic) == "table" and not relic.Found and relic.Id then
			local okInvoke, result = invoke("Relic_Found", relic.Id)
			if okInvoke and result then
				relic.Found = true
				task.wait(1)
			end
		end
	end
end

Core.SpinWheels = function()
	local wheels = getDirectoryIds("SpinnyWheels")
	local wanted = resolveSelection(settings.SelectedWheels, wheels)
	for _, wheelName in ipairs(wanted) do
		invoke("Spinny Wheel: Request Spin", wheelName)
		task.wait(0.3)
	end
end

Core.OpenChests = function()
	local chests = getChestNames()
	local wanted = resolveSelection(settings.SelectedChests, chests)
	for _, chestName in ipairs(wanted) do
		local base = chestName:gsub("%s*Chest$", "") .. " Key"
		local lowerEntry = findInventoryEntry(base .. " Lower Half")
		local upperEntry = findInventoryEntry(base .. " Upper Half")
		local lower = lowerEntry and (lowerEntry._am or 0) or 0
		local upper = upperEntry and (upperEntry._am or 0) or 0
		local amount = math.min(lower, upper)
		if amount > 0 then
			local remote = base:gsub("%s+", "") .. "_Unlock"
			if networkFolder:FindFirstChild(remote) then
				invoke(remote, 1)
				invalidateSaveCache()
				task.wait(0.4)
			end
		end
	end
end

local function combineKeys(perKey)
	local miscIds = getBucketIds("Misc")
	local seen = {}
	for _, id in ipairs(miscIds) do
		local base = id:match("^(.+) Lower Half$")
		if base and not seen[base] then
			seen[base] = true
			local lowerEntry = findInventoryEntry(base .. " Lower Half")
			local upperEntry = findInventoryEntry(base .. " Upper Half")
			local lower = lowerEntry and (lowerEntry._am or 0) or 0
			local upper = upperEntry and (upperEntry._am or 0) or 0
			local amount = perKey and 1 or math.min(lower, upper)
			if amount > 0 then
				local remote = base:gsub("%s+", "") .. "_Combine"
				if networkFolder:FindFirstChild(remote) then
					invoke(remote, base)
					invalidateSaveCache()
					task.wait(perKey and 0.5 or 0.6)
				end
			end
		end
	end
end

Core.CombineKeysAll = function() combineKeys(false) end
Core.CombineKeysOnce = function() combineKeys(true) end

Core.OpenGiftBags = function()
	local gifts = getGiftIds()
	local wanted = resolveSelection(settings.SelectedGifts, gifts)
	if #wanted == 0 then return end

	local opened = false
	for _, itemId in ipairs(wanted) do
		local entry = findInventoryEntry(itemId)
		local amount = entry and (entry._am or 0) or 0
		if amount > 0 then
			local ok = invoke("GiftBag_Open", itemId, 1)
			if ok then
				invalidateSaveCache()
				opened = true
			end
		end
	end
	return opened
end

local lootboxMaxCache = nil

local function getLootboxMaxOpen()
	if lootboxMaxCache then return lootboxMaxCache end
	lootboxMaxCache = LOOTBOX_BATCH
	local typesFolder = libraryFolder:FindFirstChild("Types")
	local mod = typesFolder and typesFolder:FindFirstChild("Lootboxes")
	if mod then
		local ok, data = pcall(require, mod)
		if ok and typeof(data) == "table" then
			local cap = data.MaxOpenAmountInstant or data.MaxOpenAmount
			if typeof(cap) == "number" and cap > 0 then
				lootboxMaxCache = cap
			end
		end
	end
	return lootboxMaxCache
end

local function buildLootboxItem(entry, uid, itemId)
	local items = Modules.Items
	if typeof(items) ~= "table" then return nil end
	local builders = {
		function() return items.Lootbox(itemId) end,
		function() return items.Lootbox(items, itemId) end,
		function() return items.From(items, entry) end,
		function() return items.From(entry) end,
		function() return items.FromModule and items.FromModule(items, entry) end,
	}
	for _, build in ipairs(builders) do
		local ok, box = pcall(build)
		if ok and typeof(box) == "table" then
			pcall(function() box._uid = uid end)
			return box
		end
	end
	return nil
end

local function openLootboxBatch(itemId, uid, batch, cmds)
	local before = findInventoryEntry(itemId)
	local beforeAmt = before and (before._am or 0) or 0

	local attempts = {}
	if cmds and typeof(cmds.Open) == "function" then
		local box = buildLootboxItem(before, uid, itemId)
		if box then
			attempts[#attempts + 1] = function() return pcall(cmds.Open, box, batch) end
			attempts[#attempts + 1] = function() return pcall(cmds.Open, cmds, box, batch) end
			attempts[#attempts + 1] = function() return pcall(cmds.Open, box) end
		end
	end
	attempts[#attempts + 1] = function() return invoke("Lootbox: Open", uid, batch) end
	attempts[#attempts + 1] = function() return invoke("Lootbox: Open", itemId, batch) end
	attempts[#attempts + 1] = function() return invoke("Lootbox: Open", uid) end

	for _, attempt in ipairs(attempts) do
		pcall(attempt)
		invalidateSaveCache()
		local after = findInventoryEntry(itemId)
		local afterAmt = after and (after._am or 0) or 0
		if afterAmt < beforeAmt then
			return true
		end
	end
	return false
end

Core.OpenLootboxes = function()
	local lootboxes = getLootboxIds()
	local wanted = resolveSelection(settings.SelectedLootboxes, lootboxes)
	if #wanted == 0 then return end

	local cmds = Modules.LootboxCmds
	local cap = getLootboxMaxOpen()

	for _, itemId in ipairs(wanted) do
		local uid = findInventoryUid(itemId)
		local entry = findInventoryEntry(itemId)
		local amount = entry and (entry._am or 0) or 0
		if uid and amount > 0 then
			local remaining = amount
			local fails = 0
			while remaining > 0 do
				local batch = math.min(remaining, cap)
				uid = findInventoryUid(itemId) or uid
				local ok = openLootboxBatch(itemId, uid, batch, cmds)
				if ok then
					fails = 0
				else
					fails += 1
					if fails >= 2 then break end
				end
				remaining -= batch
				task.wait(0.1)
			end
			task.wait(0.2)
		end
	end
end

local fruitCooldown = {}
local fruitConsumeForm = nil

local function getFruitAmount(uid)
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or typeof(save.Inventory.Fruit) ~= "table" then
		return 0
	end
	local entry = save.Inventory.Fruit[uid]
	return (typeof(entry) == "table" and (entry._am or 0)) or 0
end

local function consumeFruitStack(fruitCmds, uid, entry, amount)
	local before = getFruitAmount(uid)
	if before <= 0 then return false, 0 end

	local forms = {
		function() return fire("Fruits: Consume", uid, amount) end,
		function() return fire("Fruits: Consume", entry, amount) end,
		function() return fire("Fruits: Consume", { uid }, amount) end,
		function()
			if typeof(fruitCmds.Consume) == "function" then
				return pcall(fruitCmds.Consume, entry, amount)
			end
			return false
		end,
	}

	local order = {}
	if fruitConsumeForm then order[#order + 1] = fruitConsumeForm end
	for i = 1, #forms do
		if i ~= fruitConsumeForm then order[#order + 1] = i end
	end

	for _, idx in ipairs(order) do
		pcall(forms[idx])
		invalidateSaveCache()
		task.wait(0.15)
		local after = getFruitAmount(uid)
		if after < before then
			fruitConsumeForm = idx
			return true, before - after
		end
	end

	local consumed = 0
	for _ = 1, amount do
		local cur = getFruitAmount(uid)
		if cur <= 0 then break end
		pcall(function() return fire("Fruits: Consume", uid, 1) end)
		invalidateSaveCache()
		task.wait(0.12)
		local after = getFruitAmount(uid)
		if after < cur then
			consumed += (cur - after)
			fruitConsumeForm = 1
		else
			break
		end
	end
	if consumed > 0 then
		return true, consumed
	end
	return false, 0
end

Core.ConsumeFruits = function()
	local fruitCmds = Modules.FruitCmds
	if not fruitCmds then return end
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or typeof(save.Inventory.Fruit) ~= "table" then
		return
	end

	local wanted = resolveSelection(settings.SelectedFruits, getBucketIds("Fruit"))
	local items = {}
	for uid, entry in pairs(save.Inventory.Fruit) do
		if typeof(entry) == "table" and entry.id and (entry._am or 0) > 0 then
			if table.find(wanted, entry.id) then
				table.insert(items, { uid = uid, entry = entry })
			end
		end
	end
	if #items == 0 then return end
	table.sort(items, function(a, b) return (a.entry._am or 0) > (b.entry._am or 0) end)

	local totalConsumed = 0

	for pass = 1, 3 do
		local consumedThisPass = 0
		for _, item in ipairs(items) do
			local fruitId = item.entry.id
			local stackKey = item.entry.sh == true and "Shiny" or "Normal"
			local cooldownKey = fruitId .. "|" .. stackKey
			local last = fruitCooldown[cooldownKey]
			local now = os.clock()
			if not (last and now - last < 2) then
				local maxConsume = item.entry._am or 0
				local okLimit, value = pcall(fruitCmds.GetMaxConsume, item.entry)
				if okLimit and typeof(value) == "number" and value > 0 then
					maxConsume = math.min(maxConsume, value)
				end

				local remaining = math.min(item.entry._am or 0, maxConsume)
				if remaining > 0 then
					local batch = math.max(1, math.min(remaining, 25))
					local ok, dropped = consumeFruitStack(fruitCmds, item.uid, item.entry, batch)
					if ok then
						fruitCooldown[cooldownKey] = os.clock()
						totalConsumed += dropped
						consumedThisPass += 1
						if not vrt.fruitLog[cooldownKey] then
							vrt.fruitLog[cooldownKey] = true
							print(("[VRT] Fruit: %s (%s) x%d"):format(fruitId, stackKey, dropped))
						end
						task.wait(0.2)
					end
				end
			end
		end
		if consumedThisPass == 0 then break end
		if pass < 3 then task.wait(1) end
	end

	if totalConsumed > 0 then invalidateSaveCache() end
end

-- -----------------------------------------------------
-- Auto Time Trial
-- -----------------------------------------------------
local timeTrialChestCache = nil

local function getTimeTrialChestIds()
	if timeTrialChestCache then return timeTrialChestCache end
	timeTrialChestCache = {}
	local typesFolder = libraryFolder:FindFirstChild("Types")
	local mod = typesFolder and typesFolder:FindFirstChild("TimeTrials")
	local dirName
	if mod then
		local ok, data = pcall(require, mod)
		if ok and typeof(data) == "table" then
			dirName = data.ChestDirectory
		end
	end
	if typeof(dirName) == "string" and dirName ~= "" then
		local ids = getDirectoryIds(dirName)
		if #ids == 0 then ids = getLibraryDirIds(dirName) end
		timeTrialChestCache = ids
	end
	return timeTrialChestCache
end

Core.OpenTimeTrialChests = function()
	local remote = "TimeTrials_OpenChest"
	if networkFolder and not networkFolder:FindFirstChild(remote) then return end

	local chestIds = getTimeTrialChestIds()

	local attempts = { function() return invoke(remote) end }
	for _, id in ipairs(chestIds) do
		attempts[#attempts + 1] = function() return invoke(remote, id) end
		attempts[#attempts + 1] = function() return invoke(remote, id, 1) end
	end

	for _, attempt in ipairs(attempts) do
		pcall(attempt)
		task.wait(0.15)
	end
	invalidateSaveCache()
end

Core.FarmTreehouse = function()
	local save = getSaveCached()
	if not save then return end
	cleanupTreehouseModels()
	local keyEntry = findInventoryEntry("Secret Key")
	if not (keyEntry and (keyEntry._am or 0) > 0) then return end
	local rooms = save.SecretRooms
	if not rooms or not rooms[TREEHOUSE_ROOM] then
		invoke("SecretRoom_Unlock", TREEHOUSE_ROOM)
		task.wait(1)
		return
	end
	invoke("Instancing_PlayerEnterInstance", TREEHOUSE_ID)
	task.wait(1.5)
	Core.ClaimBestTreehouseItem()
	task.wait(1)
	fire("Instancing_PlayerLeaveInstance", TREEHOUSE_ID)
end

Core.ClaimBestTreehouseItem = function()
	local save = getSaveCached()
	if not save then return false end
	local items = save.SecretRooms and save.SecretRooms[TREEHOUSE_ROOM]
	if typeof(items) ~= "table" then return false end
	local itemsModule = Modules.Items or Modules.ItemsDir
	if typeof(itemsModule) ~= "table" then return false end
	local bestItem, bestRap
	for _, entry in ipairs(items) do
		local class = entry.class
		local data = entry.data
		if typeof(data) == "table" and data.id then
			local ctor = itemsModule[class]
			if typeof(ctor) == "function" then
				local ok, instance = pcall(ctor, data.id)
				if ok and instance then
					if class ~= "Enchant" and class ~= "Potion" and data.tn then
						pcall(function() instance:SetTier(data.tn) end)
					end
					local okRap, rap = pcall(function() return instance:GetRAP() end)
					if okRap and typeof(rap) == "number" and (not bestRap or rap > bestRap) then
						bestRap = rap
						bestItem = instance
					end
				end
			end
		end
	end
	if not bestItem then return false end
	invoke("TreehouseMerchant_Purchase", bestItem)
	return true, bestRap
end

Core.ClaimFakeCharacters = function()
	local things = workspace:FindFirstChild("__THINGS")
	local folder = things and things:FindFirstChild("AdminAbuseCharacters")
	local root = getRoot()
	if not folder or not root then return end
	for _, model in ipairs(folder:GetChildren()) do
		local fakeUid = model:GetAttribute("FakeCharUID")
		if fakeUid then
			pcall(function()
				root.CFrame = model.WorldPivot
			end)
			task.wait(0.05)
			invoke("AdminAbuse:FakeCharacter:Claim", fakeUid)
			task.wait(0.5)
		end
	end
end

Core.UpgradeFruits = function(shinyOnly)
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Fruit then
		return
	end
	local fruits = getDirectoryIds("Fruits")
	local wanted = resolveSelection(settings.SelectedFruitUpgrade, fruits)
	local payload = {}
	for uid, entry in pairs(save.Inventory.Fruit) do
		if typeof(entry) == "table" and (entry._am or 0) > 0 then
			if table.find(wanted, entry.id) then
				if shinyOnly then
					if not entry.sh then
						payload[uid] = 1
					end
				else
					payload[uid] = 1
				end
			end
		end
	end
	if not next(payload) then return end
	invoke(shinyOnly and "UpgradeShinyFruitsMachine_Activate" or "UpgradeFruitsMachine_Activate", payload)
	invalidateSaveCache()
end

Core.UpgradePotions = function()
	local save = getSaveCached()
	local balance = Modules.Balancing
	if not save or not balance or not balance.CalcPotionsPerTierRequired then return end
	if typeof(save.Inventory) ~= "table" or not save.Inventory.Potion then return end
	local payload = {}
	for uid, entry in pairs(save.Inventory.Potion) do
		if typeof(entry) ~= "table" or not entry._am then continue end
		local okCalc, perTier = pcall(balance.CalcPotionsPerTierRequired, entry.tn or 1)
		if not okCalc or not perTier or perTier <= 0 then continue end
		local crafts = entry._am // perTier
		if crafts > 0 then payload[uid] = crafts end
	end
	if next(payload) then
		invoke("UpgradePotionsMachine_ActivateBulk", payload)
		invalidateSaveCache()
	end
end

Core.UpgradeEnchants = function()
	local save = getSaveCached()
	local balance = Modules.Balancing
	if not save or not balance or not balance.CalcEnchantsPerTierRequired then return end
	if typeof(save.Inventory) ~= "table" or not save.Inventory.Enchant then return end
	local payload = {}
	for uid, entry in pairs(save.Inventory.Enchant) do
		if typeof(entry) ~= "table" or not entry._am then continue end
		local okCalc, perTier = pcall(balance.CalcEnchantsPerTierRequired, entry.tn or 1)
		if not okCalc or not perTier or perTier <= 0 then continue end
		local crafts = entry._am // perTier
		if crafts > 0 then payload[uid] = crafts end
	end
	if next(payload) then
		invoke("UpgradeEnchantsMachine_ActivateBulk", payload)
		invalidateSaveCache()
	end
end

Core.EmpowerEnchants = function()
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Enchant then return end
	local rarities = getEnchantRarities()
	local wanted = resolveSelection(settings.SelectedEnchantRarity, rarities)
	local uids, amounts = {}, {}
	for uid, entry in pairs(save.Inventory.Enchant) do
		if typeof(entry) == "table" and entry._am then
			local rarity = tostring(entry.rn or entry.rarity or "Unknown")
			if table.find(wanted, "All") or table.find(wanted, rarity) then
				table.insert(uids, uid)
				table.insert(amounts, entry._am)
			end
		end
	end
	if #uids > 0 then
		invoke("EnchantEmpowering: Empower", uids, amounts)
		invalidateSaveCache()
	end
end

Core.ScrapEnchants = function()
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Enchant then return end
	local rarities = getEnchantRarities()
	local wanted = resolveSelection(settings.SelectedEnchantRarity, rarities)
	local uids, amounts = {}, {}
	for uid, entry in pairs(save.Inventory.Enchant) do
		if typeof(entry) == "table" and entry._am then
			local rarity = tostring(entry.rn or entry.rarity or "Unknown")
			if table.find(wanted, "All") or table.find(wanted, rarity) then
				table.insert(uids, uid)
				table.insert(amounts, entry._am)
			end
		end
	end
	if #uids > 0 then
		invoke("EnchantEmpowering: Scrap", uids, amounts)
		invalidateSaveCache()
	end
end

Core.CombineCards = function()
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Card then
		return
	end
	local payload = {}
	for uid, entry in pairs(save.Inventory.Card) do
		if typeof(entry) == "table" and entry._am and entry._am >= 3 then
			payload[uid] = entry._am // 3
		end
	end
	if not next(payload) then return end
	invoke("CardCombinationMachine_ActivateBulk", payload)
	invalidateSaveCache()
end

local EVENT_PETS_MANUAL = {}

local FUSE_MIN = 3

local function getPetConfig(id, instance)
	local dir = Modules.PetsDir
	if typeof(dir) == "table" then
		local cfg = dir[id]
		if typeof(cfg) == "table" then return cfg end
		if typeof(dir.Pets) == "table" and typeof(dir.Pets[id]) == "table" then
			return dir.Pets[id]
		end
	end
	if typeof(instance) == "table" then
		if typeof(instance._config) == "table" then return instance._config end
		if typeof(instance._data) == "table" then return instance._data end
		if typeof(instance.GetConfig) == "function" then
			local ok, cfg = pcall(instance.GetConfig, instance)
			if ok and typeof(cfg) == "table" then return cfg end
		end
	end
	return nil
end

local function isFusablePet(entry, instance)
	if typeof(entry) ~= "table" then return false end
	local id = entry.id
	if typeof(id) ~= "string" then return false end
	if EVENT_PETS_MANUAL[id] then return false end
	local cfg = getPetConfig(id, instance)
	if typeof(cfg) ~= "table" then return false end
	if cfg.fromEgg == nil then return false end
	return true
end

Core.FusePets = function()
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Pet then
		return
	end
	local items = Modules.Items
	if not items or not items.Pet or not items.Pet.From then return end
	local uids = {}
	for uid, entry in pairs(save.Inventory.Pet) do
		if typeof(entry) == "table" then
			local ok, instance = pcall(items.Pet.From, items.Pet, entry)
			if ok and instance and isFusablePet(entry, instance) then
				table.insert(uids, uid)
			end
		end
	end
	local amount = tonumber(settings.FuseAmount) or 5
	if amount < 1 then amount = 1 end
	local count = math.min(#uids, amount)
	if count < FUSE_MIN then return end
	local payload = {}
	for i = 1, count do
		payload[uids[i]] = 1
	end
	invoke("FuseMachine_Activate", payload)
	invalidateSaveCache()
end

Core.GoldMachine = function()
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Pet then
		return
	end
	local items = Modules.Items
	if not items or not items.Pet or not items.Pet.From then return end
	local normals = {}
	for uid, entry in pairs(save.Inventory.Pet) do
		if typeof(entry) == "table" then
			local ok, instance = pcall(items.Pet.From, items.Pet, entry)
			if ok and instance then
				local isGolden = instance.IsGolden and instance:IsGolden()
				local isRainbow = instance.IsRainbow and instance:IsRainbow()
				if not isGolden and not isRainbow then
					table.insert(normals, uid)
				end
			end
		end
	end
	if #normals < 5 then return end
	local payload = {}
	for i = 1, math.min(#normals, 5) do
		payload[normals[i]] = 1
	end
	invoke("GoldMachine_Activate", payload)
	invalidateSaveCache()
end

Core.RainbowMachine = function()
	local save = getSaveCached()
	if not save or typeof(save.Inventory) ~= "table" or not save.Inventory.Pet then
		return
	end
	local items = Modules.Items
	if not items or not items.Pet or not items.Pet.From then return end
	local goldens = {}
	for uid, entry in pairs(save.Inventory.Pet) do
		if typeof(entry) == "table" then
			local ok, instance = pcall(items.Pet.From, items.Pet, entry)
			if ok and instance then
				local isGolden = instance.IsGolden and instance:IsGolden()
				local isRainbow = instance.IsRainbow and instance:IsRainbow()
				if isGolden and not isRainbow then
					table.insert(goldens, uid)
				end
			end
		end
	end
	if #goldens < 5 then return end
	local payload = {}
	for i = 1, math.min(#goldens, 5) do
		payload[goldens[i]] = 1
	end
	invoke("RainbowMachine_Activate", payload)
	invalidateSaveCache()
end

Core.CoinJar = function()
	local entry = findInventoryEntry("Basic Coin Jar")
	if not entry or (entry._am or 0) <= 0 then return end
	invoke("CoinJar_Spawn")
end

Core.Comet = function()
	local entry = findInventoryEntry("Comet")
	if not entry or (entry._am or 0) <= 0 then return end
	invoke("Comet_Spawn")
end

-- -----------------------------------------------------
-- Loop manager
-- -----------------------------------------------------
local function startLoop(flag, interval, callback)
	if vrt.loops[flag] then return end
	vrt.loops[flag] = true
	task.spawn(function()
		while vrt.loops[flag] and settings[flag] do
			local ok, err = pcall(callback)
			if not ok then
				warn("[VRT]", flag, err)
			end
			task.wait(interval)
		end
		vrt.loops[flag] = nil
	end)
end

local function stopLoop(flag)
	vrt.loops[flag] = nil
end

local function toggleLoop(flag, interval, callback)
	return function(value)
		settings[flag] = value
		queueSave()
		if value then
			startLoop(flag, interval, callback)
		else
			stopLoop(flag)
		end
	end
end

local function bindConnection(flag, signal, callback, cooldown)
	if vrt.connections[flag] then
		vrt.connections[flag]:Disconnect()
		vrt.connections[flag] = nil
	end
	if not settings[flag] then return end
	local interval = cooldown or settings.FastFarmCooldown or 0.2
	local lastRun = 0
	vrt.connections[flag] = signal:Connect(function()
		if not settings[flag] then return end
		local now = os.clock()
		if now - lastRun < interval then return end
		lastRun = now
		pcall(callback)
	end)
end

-- -----------------------------------------------------
-- UI.
-- -----------------------------------------------------
local RAYFIELD_URLS = {
	"https://sirius.menu/rayfield",
	"https://raw.githubusercontent.com/SiriusSoftwareLtd/Rayfield/main/source.lua",
}

local rayfield, rayfieldErr = nil, "không tải được source"
for _, url in ipairs(RAYFIELD_URLS) do
	local source = fetchUrl(url)
	if source then
		local chunk, compileErr = loadstring(source, "Rayfield")
		if chunk then
			local okRun, result = pcall(chunk)
			if okRun and typeof(result) == "table" then
				rayfield = result
				break
			end
			rayfieldErr = tostring(result)
		else
			rayfieldErr = tostring(compileErr)
		end
	end
end

if not rayfield then
	getgenv().VRT_LOADED = nil
	return warn("[VRT] Không load được Rayfield: " .. rayfieldErr)
end

local windowOk, window = pcall(function()
	return rayfield:CreateWindow({
		Name = "VRT PET SIM 99",
		LoadingTitle = "VRT PET SIM 99",
		LoadingSubtitle = "v" .. vrt.Version,
		ConfigurationSaving = { Enabled = fsReady, FolderName = "VRT_PS99", FileName = "Config" },
		Discord = { Enabled = true, Invite = "JwfXeX9gjw", RememberJoins = true },
		KeySystem = false,
	})
end)

if not windowOk or not window then
	getgenv().VRT_LOADED = nil
	return warn("[VRT] CreateWindow thất bại: " .. tostring(window))
end

local function safeTab(name, icon)
	local ok, tab = pcall(function() return window:CreateTab(name, icon) end)
	if ok and tab then return tab end
	warn("[VRT] Không tạo được tab: " .. name)
	return nil
end

local tabs = {
	farm = safeTab("Auto-Farm", "dollar-sign"),
	keys = safeTab("Auto Keys/Tickets", "box"),
	eggs = safeTab("Eggs", "egg"),
	auto = safeTab("Auto", "settings"),
	update = safeTab("Update", "refresh-cw"),
	rank = safeTab("Auto-Rank", "dollar-sign"),
	secret = safeTab("Admin Abuse", "shield"),
	mailbox = safeTab("Mailbox", "mail"),
}

local wheelsDropdown, chestsDropdown, giftsDropdown, lootboxDropdown
local fruitDropdown, fruitUpgradeDropdown, enchantRarityDropdown
local eggDropdown, customEggDropdown

local function refreshAllDropdowns()
	invalidateSaveCache()
	clearDerivedCache()
	BreakablePositions.data = nil
	BreakablePositions.timestamp = 0
	breakablePositionCache = setmetatable({}, { __mode = "k" })
	EggPositions.data = nil
	EggPositions.timestamp = 0
	eggPositionCache = setmetatable({}, { __mode = "k" })
	ZoneCache.data = nil
	ZoneCache.timestamp = 0
	pcall(function()
		if wheelsDropdown then wheelsDropdown:Refresh(buildOptions(getDirectoryIds("SpinnyWheels"))) end
		if chestsDropdown then chestsDropdown:Refresh(buildOptions(getChestNames())) end
		if giftsDropdown then giftsDropdown:Refresh(buildOptions(getGiftIds())) end
		if lootboxDropdown then lootboxDropdown:Refresh(buildOptions(getLootboxIds())) end
		if fruitDropdown then fruitDropdown:Refresh(buildOptions(getBucketIds("Fruit"))) end
		if fruitUpgradeDropdown then fruitUpgradeDropdown:Refresh(buildOptions(getDirectoryIds("Fruits"))) end
		if enchantRarityDropdown then enchantRarityDropdown:Refresh(buildOptions(getEnchantRarities())) end
		if eggDropdown then eggDropdown:Refresh(getEggIdList()) end
		if customEggDropdown then customEggDropdown:Refresh(getCustomEggOptions()) end
	end)
end

getgenv().VRT_RefreshDropdowns = refreshAllDropdowns

-- ================= AUTO-FARM =================
if tabs.farm then
	tabs.farm:CreateSection("Farming Section")
	tabs.farm:CreateSlider({
		Name = "Fast Farm Cooldown (only for Heartbeat one)",
		Range = { 0.05, 1 }, Increment = 0.01, Suffix = "s",
		CurrentValue = settings.FastFarmCooldown, Flag = "FastFarmCooldown",
		Callback = function(value) settings.FastFarmCooldown = value; queueSave() end,
	})
	tabs.farm:CreateToggle({
		Name = "Fast Farm (Heartbeat)", CurrentValue = settings.FastFarmHeartbeat, Flag = "FastFarmHeartbeat",
		Callback = function(value)
			settings.FastFarmHeartbeat = value
			queueSave()
			bindConnection("FastFarmHeartbeat", runService.Heartbeat, Core.FastFarm)
		end,
	})
	tabs.farm:CreateToggle({
		Name = "Fast Farm (While loop)", CurrentValue = settings.FastFarmLoop, Flag = "FastFarmLoop",
		Callback = toggleLoop("FastFarmLoop", 0.15, Core.FastFarm),
	})
	tabs.farm:CreateToggle({
		Name = "Auto Collect Orbs", CurrentValue = settings.CollectOrbs, Flag = "CollectOrbs",
		Callback = toggleLoop("CollectOrbs", 0.3, Core.CollectOrbs),
	})

	tabs.farm:CreateSection("Time Trial")
	tabs.farm:CreateToggle({
		Name = "Auto Time Trial (mở chest time trial)",
		CurrentValue = settings.AutoTimeTrial, Flag = "AutoTimeTrial",
		Callback = toggleLoop("AutoTimeTrial", 5, Core.OpenTimeTrialChests),
	})

	tabs.farm:CreateSection("Farm Point")
	tabs.farm:CreateButton({
		Name = "Set Farm Point (lưu vị trí hiện tại)",
		Callback = function()
			local root = getRoot()
			if not root then
				rayfield:Notify({ Title = "VRT", Content = "Không tìm thấy nhân vật", Duration = 3 })
				return
			end
			settings.FarmPoint = { x = root.Position.X, y = root.Position.Y, z = root.Position.Z }
			queueSave()
			rayfield:Notify({
				Title = "VRT",
				Content = ("Đã lưu farm point (%.0f, %.0f, %.0f)"):format(root.Position.X, root.Position.Y, root.Position.Z),
				Duration = 4,
			})
		end,
	})
	tabs.farm:CreateToggle({
		Name = "Use Farm Point", CurrentValue = settings.UseFarmPoint or false, Flag = "UseFarmPoint",
		Callback = function(value) settings.UseFarmPoint = value; queueSave() end,
	})
	tabs.farm:CreateButton({
		Name = "Clear Farm Point",
		Callback = function()
			settings.FarmPoint = nil
			settings.UseFarmPoint = false
			queueSave()
			rayfield:Notify({ Title = "VRT", Content = "Đã xoá farm point", Duration = 3 })
		end,
	})

	tabs.farm:CreateSection("Click Aura")
	tabs.farm:CreateToggle({
		Name = "Click Aura", CurrentValue = settings.ClickAura, Flag = "ClickAura",
		Callback = function(value)
			settings.ClickAura = value
			queueSave()
			vrt.clickAuraDebug = false
			bindConnection("ClickAura", runService.Heartbeat, Core.ClickAura, settings.ClickAuraCooldown or 0.016)
		end,
	})
	tabs.farm:CreateSlider({
		Name = "Click Aura Radius", Range = { 10, 250 }, Increment = 5, Suffix = "Studs",
		CurrentValue = settings.ClickAuraRadius, Flag = "ClickAuraRadius",
		Callback = function(value) settings.ClickAuraRadius = value; queueSave() end,
	})
	tabs.farm:CreateSlider({
		Name = "Click Aura Cooldown", Range = { 0.016, 0.2 }, Increment = 0.004, Suffix = "s",
		CurrentValue = settings.ClickAuraCooldown or 0.016, Flag = "ClickAuraCooldown",
		Callback = function(value)
			settings.ClickAuraCooldown = value
			queueSave()
			if settings.ClickAura then
				bindConnection("ClickAura", runService.Heartbeat, Core.ClickAura, value)
			end
		end,
	})
	tabs.farm:CreateToggle({
		Name = "Click Aura Visualizer", CurrentValue = settings.ClickAuraViz, Flag = "ClickAuraViz",
		Callback = function(value)
			settings.ClickAuraViz = value
			queueSave()
			if value then
				startLoop("ClickAuraViz", 0.1, Core.ClickAuraViz)
			else
				stopLoop("ClickAuraViz")
				Core.ClickAuraViz()
			end
		end,
	})

	tabs.farm:CreateSection("Optimize")
	tabs.farm:CreateToggle({
		Name = "Inf Pet Speed", CurrentValue = settings.InfinitePetSpeed, Flag = "InfinitePetSpeed",
		Callback = function(value)
			settings.InfinitePetSpeed = value
			queueSave()
			Core.InfinitePetSpeed(value)
		end,
	})
	tabs.farm:CreateToggle({
		Name = "Optimize Pets", CurrentValue = settings.OptimizePets, Flag = "OptimizePets",
		Callback = toggleLoop("OptimizePets", 10, Core.OptimizePets),
	})
	tabs.farm:CreateToggle({
		Name = "Anti-Lag (xoá hiệu ứng)", CurrentValue = settings.AntiLag, Flag = "AntiLag",
		Callback = function(value)
			settings.AntiLag = value
			queueSave()
			if value then
				local removed = Core.AntiLag()
				rayfield:Notify({
					Title = "Anti-Lag",
					Content = ("Đã xoá %d hiệu ứng"):format(removed or 0),
					Duration = 3,
				})
			else
				Core.StopAntiLag()
			end
		end,
	})
	tabs.farm:CreateButton({
		Name = "Optimize Breakables",
		Callback = function() Core.OptimizeBreakables() end,
	})
end

-- ================= AUTO KEYS / TICKETS =================
if tabs.keys then
	tabs.keys:CreateSection("Spinny Wheels Section")
	wheelsDropdown = tabs.keys:CreateDropdown({
		Name = "Select Which Spinny Wheels To Spin",
		Options = buildOptions(getDirectoryIds("SpinnyWheels")),
		CurrentOption = settings.SelectedWheels, MultipleOptions = true, Flag = "SelectedWheels",
		Callback = function(option) settings.SelectedWheels = option; queueSave() end,
	})
	tabs.keys:CreateToggle({
		Name = "Spin Selected Wheels", CurrentValue = settings.SpinWheels, Flag = "SpinWheels",
		Callback = toggleLoop("SpinWheels", 0.35, Core.SpinWheels),
	})

	tabs.keys:CreateSection("Chests Section")
	chestsDropdown = tabs.keys:CreateDropdown({
		Name = "Select Which Chests To Open",
		Options = buildOptions(getChestNames()),
		CurrentOption = settings.SelectedChests, MultipleOptions = true, Flag = "SelectedChests",
		Callback = function(option) settings.SelectedChests = option; queueSave() end,
	})
	tabs.keys:CreateToggle({
		Name = "Open Selected Chests", CurrentValue = settings.OpenChests, Flag = "OpenChests",
		Callback = toggleLoop("OpenChests", 1, Core.OpenChests),
	})

	tabs.keys:CreateSection("Keys Section")
	tabs.keys:CreateToggle({
		Name = "Combine Keys All at Once", CurrentValue = settings.CombineKeysAll, Flag = "CombineKeysAll",
		Callback = toggleLoop("CombineKeysAll", 3, Core.CombineKeysAll),
	})
	tabs.keys:CreateToggle({
		Name = "Combine Keys One at Once", CurrentValue = settings.CombineKeysOnce, Flag = "CombineKeysOnce",
		Callback = toggleLoop("CombineKeysOnce", 1.5, Core.CombineKeysOnce),
	})

	tabs.keys:CreateSection("Gift Bags Section")
	giftsDropdown = tabs.keys:CreateDropdown({
		Name = "Select Which Gift Bags To Open",
		Options = buildOptions(getGiftIds()),
		CurrentOption = settings.SelectedGifts, MultipleOptions = true, Flag = "SelectedGifts",
		Callback = function(option) settings.SelectedGifts = option; queueSave() end,
	})
	tabs.keys:CreateToggle({
		Name = "Open Selected Gift Bags (Max)", CurrentValue = settings.OpenGifts, Flag = "OpenGifts",
		Callback = toggleLoop("OpenGifts", 0.33, Core.OpenGiftBags),
	})

	tabs.keys:CreateSection("Lootboxes Section")
	lootboxDropdown = tabs.keys:CreateDropdown({
		Name = "Select Which Lootboxes To Open",
		Options = buildOptions(getLootboxIds()),
		CurrentOption = settings.SelectedLootboxes, MultipleOptions = true, Flag = "SelectedLootboxes",
		Callback = function(option) settings.SelectedLootboxes = option; queueSave() end,
	})
	tabs.keys:CreateToggle({
		Name = "Open Selected Lootboxes (1 type per tick)", CurrentValue = settings.OpenLootboxes, Flag = "OpenLootboxes",
		Callback = toggleLoop("OpenLootboxes", 1, Core.OpenLootboxes),
	})

	tabs.keys:CreateSection("Fruits Section")
	fruitDropdown = tabs.keys:CreateDropdown({
		Name = "Select Fruits to Use",
		Options = buildOptions(getBucketIds("Fruit")),
		CurrentOption = settings.SelectedFruits, MultipleOptions = true, Flag = "SelectedFruits",
		Callback = function(option) settings.SelectedFruits = option; queueSave() end,
	})
	tabs.keys:CreateToggle({
		Name = "Use Selected Fruits (Max per type)", CurrentValue = settings.ConsumeFruits, Flag = "ConsumeFruits",
		Callback = function(value)
			settings.ConsumeFruits = value
			queueSave()
			vrt.fruitLog = {}
			if value then startLoop("ConsumeFruits", 3, Core.ConsumeFruits) else stopLoop("ConsumeFruits") end
		end,
	})

	tabs.keys:CreateSection("Secret Keys Section")
	tabs.keys:CreateToggle({
		Name = "Farm Treehouse Merchant", CurrentValue = settings.FarmTreehouse, Flag = "FarmTreehouse",
		Callback = toggleLoop("FarmTreehouse", 5, Core.FarmTreehouse),
	})
	tabs.keys:CreateButton({
		Name = "Unlock Treehouse",
		Callback = function() invoke("SecretRoom_Unlock", TREEHOUSE_ROOM) end,
	})
	tabs.keys:CreateButton({
		Name = "Enter Treehouse",
		Callback = function() invoke("Instancing_PlayerEnterInstance", TREEHOUSE_ID) end,
	})
	tabs.keys:CreateButton({
		Name = "Leave Treehouse",
		Callback = function() fire("Instancing_PlayerLeaveInstance", TREEHOUSE_ID) end,
	})
end

-- ================= EGGS =================
if tabs.eggs then
	tabs.eggs:CreateSection("Egg Opening")
	tabs.eggs:CreateToggle({
		Name = "Hide Egg Animation", CurrentValue = settings.HideEggAnim, Flag = "HideEggAnim",
		Callback = function(value)
			settings.HideEggAnim = value
			queueSave()
			if value then pcall(hideEggGuis) end
			pcall(installEggHook)
		end,
	})
	tabs.eggs:CreateToggle({
		Name = "Hook Egg Animation (Message.Bottom, no anim)",
		CurrentValue = settings.HookEggAnimation or false, Flag = "HookEggAnimation",
		Callback = function(value)
			settings.HookEggAnimation = value
			queueSave()
			pcall(installEggHook)
		end,
	})
	tabs.eggs:CreateToggle({
		Name = "Auto Open Closest Egg (Max)", CurrentValue = settings.OpenEgg, Flag = "OpenEgg",
		Callback = function(value)
			settings.OpenEgg = value
			queueSave()
			vrt.eggDebugLogged = false
			if value then startLoop("OpenEgg", 0.3, Core.OpenEgg) else stopLoop("OpenEgg") end
		end,
	})

	tabs.eggs:CreateSection("Select Egg (Normal)")
	eggDropdown = tabs.eggs:CreateDropdown({
		Name = "Select Egg To Open",
		Options = getEggIdList(),
		CurrentOption = { settings.SelectedEggId ~= "" and settings.SelectedEggId or (getEggIdList()[1] or "") },
		MultipleOptions = false, Flag = "SelectedEggId",
		Callback = function(option) settings.SelectedEggId = option[1]; queueSave() end,
	})
	tabs.eggs:CreateToggle({
		Name = "Auto Open Selected Egg (Max, no teleport)", CurrentValue = settings.OpenSelectedEgg, Flag = "OpenSelectedEgg",
		Callback = function(value)
			settings.OpenSelectedEgg = value
			queueSave()
			if value then startLoop("OpenSelectedEgg", 0.3, Core.OpenSelectedEgg) else stopLoop("OpenSelectedEgg") end
		end,
	})

	tabs.eggs:CreateSection("Select Egg (Custom)")
	customEggDropdown = tabs.eggs:CreateDropdown({
		Name = "Select Custom Egg (chỉ _hatchable)",
		Options = getCustomEggOptions(),
		CurrentOption = { settings.SelectedCustomEggUuid ~= "" and settings.SelectedCustomEggUuid or (getCustomEggOptions()[1] or "") },
		MultipleOptions = false, Flag = "SelectedCustomEggUuid",
		Callback = function(option)
			local display = option[1]
			local info = vrt.customEggMap[display]
			local uuid = info and info.uid or display
			settings.SelectedCustomEggUuid = uuid
			queueSave()
		end,
	})
	tabs.eggs:CreateToggle({
		Name = "Auto Buy Selected Custom Egg (Max, no teleport)", CurrentValue = settings.BuySelectedCustomEgg, Flag = "BuySelectedCustomEgg",
		Callback = function(value)
			settings.BuySelectedCustomEgg = value
			queueSave()
			if value then startLoop("BuySelectedCustomEgg", 0.6, Core.BuySelectedCustomEgg) else stopLoop("BuySelectedCustomEgg") end
		end,
	})

	tabs.eggs:CreateSection("Utility")
	tabs.eggs:CreateButton({
		Name = "Refresh Dropdowns",
		Callback = function()
			clearDirectoryCache()
			refreshAllDropdowns()
			rayfield:Notify({ Title = "VRT", Content = "Đã refresh dropdowns", Duration = 3 })
		end,
	})
end

-- ================= AUTO =================
if tabs.auto then
	tabs.auto:CreateToggle({
		Name = "Auto Daycare (Claim and Enroll)", CurrentValue = settings.Daycare, Flag = "Daycare",
		Callback = toggleLoop("Daycare", 30, Core.Daycare),
	})
	tabs.auto:CreateToggle({
		Name = "Buy Pet Slots", CurrentValue = settings.PetSlots, Flag = "PetSlots",
		Callback = toggleLoop("PetSlots", 10, Core.BuyPetSlots),
	})
	tabs.auto:CreateToggle({
		Name = "Buy Egg Slots", CurrentValue = settings.AutoEggSlots, Flag = "AutoEggSlots",
		Callback = toggleLoop("AutoEggSlots", 10, Core.BuyEggSlots),
	})
	tabs.auto:CreateToggle({
		Name = "Buy Next Zone", CurrentValue = settings.Zones, Flag = "Zones",
		Callback = toggleLoop("Zones", 2, Core.BuyZone),
	})
	tabs.auto:CreateToggle({
		Name = "Auto Rebirth", CurrentValue = settings.Rebirth, Flag = "Rebirth",
		Callback = toggleLoop("Rebirth", 5, Core.Rebirth),
	})
	tabs.auto:CreateToggle({
		Name = "Use Ultimate", CurrentValue = settings.Ultimate, Flag = "Ultimate",
		Callback = toggleLoop("Ultimate", 2, Core.UseUltimate),
	})
	tabs.auto:CreateToggle({
		Name = "Auto Free Gifts", CurrentValue = settings.FreeGifts, Flag = "FreeGifts",
		Callback = toggleLoop("FreeGifts", 60, Core.ClaimFreeGifts),
	})
	tabs.auto:CreateToggle({
		Name = "Collect Shiny Relics", CurrentValue = settings.Relics, Flag = "Relics",
		Callback = toggleLoop("Relics", 5, Core.CollectRelics),
	})

	tabs.auto:CreateSection("Machine")
	tabs.auto:CreateToggle({
		Name = "Auto Combine Cards", CurrentValue = settings.CardCombine, Flag = "CardCombine",
		Callback = toggleLoop("CardCombine", 3, Core.CombineCards),
	})
	tabs.auto:CreateToggle({
		Name = "Auto Fuse Pets (Rainbow/Golden/Shiny)", CurrentValue = settings.FusePets, Flag = "FusePets",
		Callback = toggleLoop("FusePets", 0.5, Core.FusePets),
	})
	tabs.auto:CreateSlider({
		Name = "Fuse Amount (số lượng Pet mỗi lần ép)",
		Range = { 1, 100 }, Increment = 1, Suffix = "pets",
		CurrentValue = settings.FuseAmount or 5, Flag = "FuseAmount",
		Callback = function(value) settings.FuseAmount = value; queueSave() end,
	})
	tabs.auto:CreateToggle({
		Name = "Auto Gold Machine", CurrentValue = settings.GoldMachine, Flag = "GoldMachine",
		Callback = toggleLoop("GoldMachine", 5, Core.GoldMachine),
	})
	tabs.auto:CreateToggle({
		Name = "Auto Rainbow Machine", CurrentValue = settings.RainbowMachine, Flag = "RainbowMachine",
		Callback = toggleLoop("RainbowMachine", 5, Core.RainbowMachine),
	})

	tabs.auto:CreateSection("Spawn")
	tabs.auto:CreateToggle({
		Name = "Auto Coin Jar", CurrentValue = settings.CoinJar, Flag = "CoinJar",
		Callback = toggleLoop("CoinJar", 5, Core.CoinJar),
	})
	tabs.auto:CreateToggle({
		Name = "Auto Comet", CurrentValue = settings.Comet, Flag = "Comet",
		Callback = toggleLoop("Comet", 5, Core.Comet),
	})

	tabs.auto:CreateSection("Flags")
	local initialFlag = settings.SelectedFlag
	if not table.find(FLAGS, initialFlag) then
		initialFlag = FLAGS[1]
		settings.SelectedFlag = initialFlag
		queueSave()
	end
	tabs.auto:CreateDropdown({
		Name = "Select Flag To Use", Options = FLAGS,
		CurrentOption = { initialFlag }, MultipleOptions = false, Flag = "SelectedFlag",
		Callback = function(option)
			settings.SelectedFlag = option[1]
			queueSave()
			vrt.flagWarned = {}
			vrt.flagInfoWarned = false
			vrt.flagSuccessLogged = false
			vrt.flagFailLogged = false
			flagAutoCache.zoneLog = {}
			flagAutoCache.failLog = {}
		end,
	})
	tabs.auto:CreateSlider({
		Name = "Flag Amount to Use (số lượng dùng mỗi lần)",
		Range = { 1, 45 }, Increment = 1, Suffix = "flags",
		CurrentValue = settings.FlagAmount or 45, Flag = "FlagAmount",
		Callback = function(value) settings.FlagAmount = value; queueSave() end,
	})
	tabs.auto:CreateToggle({
		Name = "Auto Use Flag When In Zone (no teleport)",
		CurrentValue = settings.AutoUseFlagInZone or false,
		Flag = "AutoUseFlagInZone",
		Callback = function(value)
			settings.AutoUseFlagInZone = value
			queueSave()
			flagAutoCache.zoneLog = {}
			flagAutoCache.failLog = {}
			flagAutoCache.lastConsume = 0
			if value then
				startLoop("AutoUseFlagInZone", 1, Core.AutoUseFlag)
			else
				stopLoop("AutoUseFlagInZone")
			end
		end,
	})
end

-- ================= UPDATE =================
if tabs.update then
	tabs.update:CreateSection("Fruits")
	fruitUpgradeDropdown = tabs.update:CreateDropdown({
		Name = "Select Fruits To Upgrade",
		Options = buildOptions(getDirectoryIds("Fruits")),
		CurrentOption = settings.SelectedFruitUpgrade, MultipleOptions = true, Flag = "SelectedFruitUpgrade",
		Callback = function(option) settings.SelectedFruitUpgrade = option; queueSave() end,
	})
	tabs.update:CreateToggle({
		Name = "Upgrade Selected Fruits", CurrentValue = settings.UpgradeFruits, Flag = "UpgradeFruits",
		Callback = toggleLoop("UpgradeFruits", 2, function() Core.UpgradeFruits(false) end),
	})
	tabs.update:CreateToggle({
		Name = "Upgrade Shiny Fruits Only", CurrentValue = settings.UpgradeFruitsShiny, Flag = "UpgradeFruitsShiny",
		Callback = toggleLoop("UpgradeFruitsShiny", 2, function() Core.UpgradeFruits(true) end),
	})

	tabs.update:CreateSection("Potions")
	tabs.update:CreateToggle({
		Name = "Upgrade All Potions (Bulk)", CurrentValue = settings.UpgradePotions, Flag = "UpgradePotions",
		Callback = toggleLoop("UpgradePotions", 2, Core.UpgradePotions),
	})

	tabs.update:CreateSection("Enchants")
	enchantRarityDropdown = tabs.update:CreateDropdown({
		Name = "Select Enchant Rarity",
		Options = buildOptions(getEnchantRarities()),
		CurrentOption = settings.SelectedEnchantRarity, MultipleOptions = true, Flag = "SelectedEnchantRarity",
		Callback = function(option) settings.SelectedEnchantRarity = option; queueSave() end,
	})
	tabs.update:CreateToggle({
		Name = "Upgrade All Enchants", CurrentValue = settings.UpgradeEnchants, Flag = "UpgradeEnchants",
		Callback = toggleLoop("UpgradeEnchants", 2, Core.UpgradeEnchants),
	})
	tabs.update:CreateToggle({
		Name = "Empower Selected Rarity", CurrentValue = settings.EmpowerEnchants, Flag = "EmpowerEnchants",
		Callback = toggleLoop("EmpowerEnchants", 2, Core.EmpowerEnchants),
	})
end

-- ================= AUTO-RANK =================
if tabs.rank then
	tabs.rank:CreateSection("Ranking Section")
	tabs.rank:CreateToggle({
		Name = "Auto Claim Rank Rewards", CurrentValue = settings.RankRewards, Flag = "RankRewards",
		Callback = toggleLoop("RankRewards", 5, Core.ClaimRankRewards),
	})
	local AUTO_RANK_URL = "https://raw.githubusercontent.com/ryomolochiton/367/refs/heads/main/AutoRank.lua"
	vrt.loadAutoRank = function()
		if vrt.autoRankFunc then return vrt.autoRankFunc end
		local source = fetchUrl(AUTO_RANK_URL)
		if typeof(source) ~= "string" then return nil, "Không tải được script Auto Rank" end
		local chunk, err = loadstring(source, "AutoRank")
		if not chunk then return nil, "Compile lỗi: " .. tostring(err) end
		local okRun, result = pcall(chunk)
		if not okRun then return nil, "Chạy lỗi: " .. tostring(result) end
		if typeof(result) == "function" then
			vrt.autoRankFunc = result
			return result
		end
		vrt.autoRankFunc = function() end
		return vrt.autoRankFunc
	end
	local loadAutoRank = vrt.loadAutoRank
	tabs.rank:CreateButton({
		Name = "Access Auto Rank",
		Callback = function()
			local func, err = loadAutoRank()
			rayfield:Notify({
				Title = "Auto Rank",
				Content = func and "Đã load Auto Rank module." or (err or "Load thất bại"),
				Duration = func and 4 or 8,
			})
		end,
	})
	tabs.rank:CreateLabel("Auto Rank is free for now.\nlast update: 28.04.2026", "refresh-cw")
	tabs.rank:CreateToggle({
		Name = "Auto Rank", CurrentValue = settings.AutoRank, Flag = "AutoRank",
		Callback = function(value)
			settings.AutoRank = value
			queueSave()
			if not value then stopLoop("AutoRank"); return end
			local func, err = loadAutoRank()
			if not func then
				settings.AutoRank = false
				queueSave()
				rayfield:Notify({ Title = "Auto Rank", Content = err or "Load thất bại", Duration = 8 })
				return
			end
			startLoop("AutoRank", 2, func)
		end,
	})
end

-- ================= ADMIN ABUSE =================
if tabs.secret then
	tabs.secret:CreateSection("Admin Abuse Section")
	tabs.secret:CreateToggle({
		Name = "Auto Claim Hidden Exclusive Egg", CurrentValue = settings.AdminAbuse or false, Flag = "AdminAbuse",
		Callback = function(value)
			settings.AdminAbuse = value
			queueSave()
			if value then startLoop("AdminAbuse", 5, Core.ClaimFakeCharacters) else stopLoop("AdminAbuse") end
		end,
	})

	tabs.secret:CreateSection("Anti-Cheat")
	tabs.secret:CreateToggle({
		Name = "Log Blocked AC Messages", CurrentValue = false, Flag = "ACLogBlocked",
		Callback = function(value) AntiCheat.logBlocked = value end,
	})
	tabs.secret:CreateButton({
		Name = "Reinstall Blunder Bypass",
		Callback = function()
			AntiCheat.originalKey = nil
			local ok = installBlunderBypass()
			rayfield:Notify({
				Title = "Anti-Cheat",
				Content = ok and "Đã cài lại bypass." or "Cài đặt thất bại.",
				Duration = 4,
			})
		end,
	})

	tabs.secret:CreateSection("Performance")
	tabs.secret:CreateButton({
		Name = "Clear All Caches",
		Callback = function()
			invalidateSaveCache()
			clearDirectoryCache()
			clearDerivedCache()
			BreakablePositions.data = nil
			BreakablePositions.timestamp = 0
			breakablePositionCache = setmetatable({}, { __mode = "k" })
			EggPositions.data = nil
			EggPositions.timestamp = 0
			eggPositionCache = setmetatable({}, { __mode = "k" })
			ZoneCache.data = nil
			ZoneCache.timestamp = 0
			clickAuraCache.names = {}
			clickAuraCache.rootPos = nil
			clickAuraCache.timestamp = 0
			fruitCooldown = {}
			vrt.fruitLog = {}
			flagAutoCache.zoneLog = {}
			flagAutoCache.failLog = {}
			rayfield:Notify({ Title = "VRT", Content = "Đã xoá tất cả cache", Duration = 3 })
		end,
	})
end

-- ================= MAILBOX =================
if tabs.mailbox then
	tabs.mailbox:CreateInput({
		Name = "Input Username", PlaceholderText = "Input Username",
		CurrentValue = settings.MailboxUsername, RemoveTextAfterFocusLost = false, Flag = "MailboxUsername",
		Callback = function(value) settings.MailboxUsername = value; queueSave() end,
	})
	tabs.mailbox:CreateDropdown({
		Name = "Send Huges Mode", Options = { "New", "All" },
		CurrentOption = { settings.MailboxHugeMode }, MultipleOptions = false, Flag = "MailboxHugeMode",
		Callback = function(option)
			settings.MailboxHugeMode = option[1]
			vrt.sentHuges = {}
			queueSave()
		end,
	})
	tabs.mailbox:CreateToggle({
		Name = "Send Huges By Mode", CurrentValue = settings.MailboxSendHuges, Flag = "MailboxSendHuges",
		Callback = toggleLoop("MailboxSendHuges", 10, Core.MailboxSendHuges),
	})
	tabs.mailbox:CreateToggle({
		Name = "Auto Claim Mailbox", CurrentValue = settings.MailboxClaim, Flag = "MailboxClaim",
		Callback = toggleLoop("MailboxClaim", 10, Core.MailboxClaimAll),
	})
	tabs.mailbox:CreateButton({
		Name = "Reset Sent Huges",
		Callback = function()
			vrt.sentHuges = {}
			rayfield:Notify({ Title = "VRT", Content = "Đã reset danh sách huge đã gửi", Duration = 3 })
		end,
	})

	tabs.mailbox:CreateSection("Config")
	tabs.mailbox:CreateButton({
		Name = "Save Config Now",
		Callback = function()
			saveConfig()
			rayfield:Notify({ Title = "Config", Content = "Đã lưu vào " .. CONFIG_PATH, Duration = 4 })
		end,
	})
	tabs.mailbox:CreateButton({
		Name = "Reset Config",
		Callback = function()
			pcall(function()
				safeDelFile(CONFIG_PATH)
			end)
			rayfield:Notify({
				Title = "Config",
				Content = "Đã xoá config. Restart script để về mặc định.",
				Duration = 5,
			})
		end,
	})
end

-- -----------------------------------------------------
-- Refresh dropdowns
-- -----------------------------------------------------
task.spawn(function()
	task.wait(3)
	pcall(refreshAllDropdowns)
end)

-- -----------------------------------------------------
-- Invalidate breakable cache on new breakable
-- -----------------------------------------------------
do
	local brkFolder = getBreakableFolder()
	if brkFolder then
		brkFolder.ChildAdded:Connect(function()
			BreakablePositions.timestamp = 0
		end)
	end
end

-- -----------------------------------------------------
-- Apply saved toggles
-- -----------------------------------------------------
task.spawn(function()
	task.wait(2)

	if settings.FastFarmHeartbeat then
		bindConnection("FastFarmHeartbeat", runService.Heartbeat, Core.FastFarm)
	end
	if settings.ClickAura then
		bindConnection("ClickAura", runService.Heartbeat, Core.ClickAura, settings.ClickAuraCooldown or 0.016)
	end
	if settings.FastFarmLoop then startLoop("FastFarmLoop", 0.15, Core.FastFarm) end
	if settings.CollectOrbs then startLoop("CollectOrbs", 0.3, Core.CollectOrbs) end
	if settings.ClickAuraViz then startLoop("ClickAuraViz", 0.1, Core.ClickAuraViz) end
	if settings.OptimizePets then startLoop("OptimizePets", 10, Core.OptimizePets) end
	if settings.SpinWheels then startLoop("SpinWheels", 0.35, Core.SpinWheels) end
	if settings.OpenChests then startLoop("OpenChests", 1, Core.OpenChests) end
	if settings.CombineKeysAll then startLoop("CombineKeysAll", 3, Core.CombineKeysAll) end
	if settings.CombineKeysOnce then startLoop("CombineKeysOnce", 1.5, Core.CombineKeysOnce) end
	if settings.OpenGifts then startLoop("OpenGifts", 1, Core.OpenGiftBags) end
	if settings.OpenLootboxes then startLoop("OpenLootboxes", 1, Core.OpenLootboxes) end
	if settings.ConsumeFruits then startLoop("ConsumeFruits", 3, Core.ConsumeFruits) end
	if settings.AutoTimeTrial then startLoop("AutoTimeTrial", 5, Core.OpenTimeTrialChests) end
	if settings.FarmTreehouse then startLoop("FarmTreehouse", 5, Core.FarmTreehouse) end
	if settings.OpenEgg then startLoop("OpenEgg", 0.3, Core.OpenEgg) end
	if settings.OpenSelectedEgg then startLoop("OpenSelectedEgg", 0.3, Core.OpenSelectedEgg) end
	if settings.BuySelectedCustomEgg then startLoop("BuySelectedCustomEgg", 0.6, Core.BuySelectedCustomEgg) end
	if settings.Daycare then startLoop("Daycare", 30, Core.Daycare) end
	if settings.PetSlots then startLoop("PetSlots", 10, Core.BuyPetSlots) end
	if settings.AutoEggSlots then startLoop("AutoEggSlots", 10, Core.BuyEggSlots) end
	if settings.Zones then startLoop("Zones", 2, Core.BuyZone) end
	if settings.Rebirth then startLoop("Rebirth", 5, Core.Rebirth) end
	if settings.Ultimate then startLoop("Ultimate", 2, Core.UseUltimate) end
	if settings.FreeGifts then startLoop("FreeGifts", 60, Core.ClaimFreeGifts) end
	if settings.Relics then startLoop("Relics", 5, Core.CollectRelics) end
	if settings.RankRewards then startLoop("RankRewards", 5, Core.ClaimRankRewards) end
	if settings.AutoRank and typeof(vrt.loadAutoRank) == "function" then
		local func = vrt.loadAutoRank()
		if func then
			startLoop("AutoRank", 2, func)
		else
			settings.AutoRank = false
		end
	end
	if settings.UpgradeFruits then startLoop("UpgradeFruits", 2, function() Core.UpgradeFruits(false) end) end
	if settings.UpgradeFruitsShiny then startLoop("UpgradeFruitsShiny", 2, function() Core.UpgradeFruits(true) end) end
	if settings.UpgradePotions then startLoop("UpgradePotions", 2, Core.UpgradePotions) end
	if settings.UpgradeEnchants then startLoop("UpgradeEnchants", 2, Core.UpgradeEnchants) end
	if settings.EmpowerEnchants then startLoop("EmpowerEnchants", 2, Core.EmpowerEnchants) end
	if settings.CardCombine then startLoop("CardCombine", 3, Core.CombineCards) end
	if settings.FusePets then startLoop("FusePets", 0.5, Core.FusePets) end
	if settings.GoldMachine then startLoop("GoldMachine", 5, Core.GoldMachine) end
	if settings.RainbowMachine then startLoop("RainbowMachine", 5, Core.RainbowMachine) end
	if settings.CoinJar then startLoop("CoinJar", 5, Core.CoinJar) end
	if settings.Comet then startLoop("Comet", 5, Core.Comet) end
	if settings.MailboxSendHuges then startLoop("MailboxSendHuges", 10, Core.MailboxSendHuges) end
	if settings.MailboxClaim then startLoop("MailboxClaim", 10, Core.MailboxClaimAll) end
	if settings.InfinitePetSpeed then Core.InfinitePetSpeed(true) end
	if settings.AutoUseFlagInZone then startLoop("AutoUseFlagInZone", 1, Core.AutoUseFlag) end
	if settings.AdminAbuse then startLoop("AdminAbuse", 5, Core.ClaimFakeCharacters) end
	if settings.HookEggAnimation or settings.HideEggAnim then pcall(installEggHook) end
end)

-- -----------------------------------------------------
-- Unload
-- -----------------------------------------------------
getgenv().VRT_Unload = function()
	getgenv().VRT_LOADED = false
	for flag, connection in pairs(vrt.connections) do
		pcall(function() connection:Disconnect() end)
		vrt.connections[flag] = nil
	end
	for flag in pairs(vrt.loops) do
		vrt.loops[flag] = nil
	end
	Core.ClickAuraViz()
	Core.InfinitePetSpeed(false)
	if vrt.optimizeConnection then
		pcall(function() vrt.optimizeConnection:Disconnect() end)
		vrt.optimizeConnection = nil
	end
	for _, key in ipairs({ "hideEggConnection", "idledConnection" }) do
		if vrt[key] then
			pcall(function() vrt[key]:Disconnect() end)
			vrt[key] = nil
		end
	end
	for gui, conn in pairs(vrt.eggGuiConnections or {}) do
		pcall(function() conn:Disconnect() end)
	end
	vrt.eggGuiConnections = {}

	if AntiCheat.originalKey then
		pcall(function()
			local blunderMessage = require(replicatedStorage:WaitForChild("Blunder", 5):WaitForChild("BlunderMessage", 5))
			pcall(setreadonly, blunderMessage, false)
			blunderMessage.key = AntiCheat.originalKey
			pcall(setreadonly, blunderMessage, true)
		end)
		AntiCheat.originalKey = nil
		AntiCheat.active = false
	end

	if eggHookState.callOriginal and eggHookState.frontend and eggHookState.funcName then
		pcall(function()
			eggHookState.frontend[eggHookState.funcName] = eggHookState.callOriginal
		end)
	end
	eggHookState.hook = nil
	eggHookState.callOriginal = nil
	eggHookState.thread = nil
	eggHookState.script = nil
	eggHookState.message = nil

	pcall(saveConfig)
	pcall(function() rayfield:Destroy() end)
end

-- -----------------------------------------------------
-- Send webhook
-- -----------------------------------------------------
task.spawn(function()
	task.wait(2)
	pcall(sendExecutionWebhook)
end)

print(("[VRT] v%s | %s | AC=%s | request=%s fs=%s getsenv=%s getconnections=%s"):format(
	vrt.Version, executorName, AntiCheat.active and "ON" or "OFF",
	tostring(httpRequest ~= nil), tostring(fsReady), tostring(hasFn(getsenv)), tostring(hasFn(getconnections))
))
