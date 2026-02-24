$server = '172.18.1.153'
$connStr = "Server=$server;Database=uat-aging;Integrated Security=True;TrustServerCertificate=True;"
$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)

try {
    $conn.Open()
    Write-Host "Connected successfully!" -ForegroundColor Green
} catch {
    Write-Host "Connection failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$queries = @(
    @{
        label = "=== OLD TABLES (ncs-conv-aging) - Columns ==="
        sql   = "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM [ncs-conv-aging].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN ('conv$vinpahistory','conv$vinpalrentalhistory','conv$vinpalrtrespasserhist','conv$vinplhistory') ORDER BY TABLE_NAME, ORDINAL_POSITION"
    },
    @{
        label = "=== NEW TABLES (ncs-npl-aging) - Columns ==="
        sql   = "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM [ncs-npl-aging].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN ('la$lahistloantransactionhistory','ln$lnhistloantransactionhistory') ORDER BY TABLE_NAME, ORDINAL_POSITION"
    },
    @{
        label = "=== ROW COUNTS ==="
        sql   = "SELECT 'conv`$vinpahistory' as tbl, COUNT(*) as cnt FROM [ncs-conv-aging].dbo.[conv`$vinpahistory] UNION ALL SELECT 'conv`$vinpalrentalhistory', COUNT(*) FROM [ncs-conv-aging].dbo.[conv`$vinpalrentalhistory] UNION ALL SELECT 'conv`$vinpalrtrespasserhist', COUNT(*) FROM [ncs-conv-aging].dbo.[conv`$vinpalrtrespasserhist] UNION ALL SELECT 'conv`$vinplhistory', COUNT(*) FROM [ncs-conv-aging].dbo.[conv`$vinplhistory] UNION ALL SELECT 'la`$lahistloantransactionhistory', COUNT(*) FROM [ncs-npl-aging].dbo.[la`$lahistloantransactionhistory] UNION ALL SELECT 'ln`$lnhistloantransactionhistory', COUNT(*) FROM [ncs-npl-aging].dbo.[ln`$lnhistloantransactionhistory]"
    },
    @{
        label = "=== SAMPLE: conv`$vinpahistory (TOP 2) ==="
        sql   = "SELECT TOP 2 * FROM [ncs-conv-aging].dbo.[conv`$vinpahistory]"
    },
    @{
        label = "=== SAMPLE: conv`$vinplhistory (TOP 2) ==="
        sql   = "SELECT TOP 2 * FROM [ncs-conv-aging].dbo.[conv`$vinplhistory]"
    },
    @{
        label = "=== SAMPLE: ln`$lnhistloantransactionhistory (TOP 2) ==="
        sql   = "SELECT TOP 2 * FROM [ncs-npl-aging].dbo.[ln`$lnhistloantransactionhistory]"
    }
)

foreach ($q in $queries) {
    Write-Host "`n$($q.label)" -ForegroundColor Cyan
    try {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $q.sql
        $reader = $cmd.ExecuteReader()
        $cols = @()
        for ($i = 0; $i -lt $reader.FieldCount; $i++) { $cols += $reader.GetName($i) }
        Write-Host ($cols -join " | ")
        Write-Host ("-" * 80)
        while ($reader.Read()) {
            $row = @()
            foreach ($c in $cols) { $row += "$($reader[$c])" }
            Write-Host ($row -join " | ")
        }
        $reader.Close()
    } catch {
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    }
}

$conn.Close()
Write-Host "`nDone." -ForegroundColor Green
